import { describe, expect, it } from 'vitest';
import { reduce } from '../src/reduce';
import { emptyRow, type IndexEvent, type IndexRow } from '../src/types';

const TIMEOUT = 10 * 60_000;

// Frozen so any accidental mutation inside reduce throws.
function makeRow(overrides: Partial<IndexRow> = {}): IndexRow {
  const row = { ...emptyRow('e1'), templateId: 't1', currentVersion: 3, versionObservedAt: 100, ...overrides };
  if (row.inProgress) Object.freeze(row.inProgress);
  return Object.freeze(row);
}

function applyAll(row: IndexRow, events: IndexEvent[]): IndexRow {
  return events.reduce((acc, event) => reduce(acc, event, TIMEOUT).row, row);
}

describe('reduce: apply', () => {
  const succeeded: IndexEvent = { type: 'ApplySucceeded', engagementId: 'e1', occurredAt: 200, from: 3, to: 7 };

  it('ignores a duplicate ApplySucceeded the second time', () => {
    const once = reduce(makeRow(), succeeded, TIMEOUT).row;
    const twice = reduce(once, succeeded, TIMEOUT).row;
    expect(twice).toEqual(once);
  });

  it('ignores ApplySucceeded whose from does not match currentVersion', () => {
    const row = makeRow({ currentVersion: 4 });
    expect(reduce(row, succeeded, TIMEOUT).row).toEqual(row);
  });

  it('ApplySucceeded sets the new version, resets declinedThroughVersion to 0 and clears inProgress', () => {
    const row = makeRow({ declinedThroughVersion: 5, inProgress: { since: 150 } });
    expect(reduce(row, succeeded, TIMEOUT).row).toEqual({
      ...row,
      currentVersion: 7,
      declinedThroughVersion: 0,
      inProgress: null,
      versionObservedAt: 200,
    });
  });

  it('a late ApplySucceeded still moves the version after the lock has expired', () => {
    const row = makeRow({ inProgress: { since: 150 } });
    const late: IndexEvent = { ...succeeded, occurredAt: 150 + TIMEOUT * 3 };
    const result = reduce(row, late, TIMEOUT).row;
    expect(result.currentVersion).toBe(7);
    expect(result.inProgress).toBeNull();
  });

  it('ApplySucceeded after a load already reported the new version clears the lock', () => {
    const row = makeRow({ inProgress: { since: 150 } });
    const loaded: IndexEvent = { type: 'EngagementLoaded', engagementId: 'e1', occurredAt: 180, templateId: 't1', version: 7 };
    const result = applyAll(row, [loaded, succeeded]);
    expect(result.currentVersion).toBe(7);
    expect(result.inProgress).toBeNull();
  });

  it('a redelivered old ApplySucceeded does not clear the lock of a newer apply', () => {
    const row = makeRow({ currentVersion: 7, versionObservedAt: 200, inProgress: { since: 300 } });
    expect(reduce(row, succeeded, TIMEOUT).row).toEqual(row);
  });

  it('ApplyFailed clears inProgress and leaves the version unchanged', () => {
    const row = makeRow({ inProgress: { since: 150 } });
    const failed: IndexEvent = { type: 'ApplyFailed', engagementId: 'e1', occurredAt: 200, from: 3, to: 7 };
    expect(reduce(row, failed, TIMEOUT).row).toEqual({ ...row, inProgress: null });
  });

  it('ignores ApplyRequested while another apply holds an unexpired lock', () => {
    const row = makeRow({ inProgress: { since: 150 } });
    const requested: IndexEvent = { type: 'ApplyRequested', engagementId: 'e1', occurredAt: 160, from: 3, to: 7 };
    expect(reduce(row, requested, TIMEOUT).row).toEqual(row);
  });
});

describe('reduce: decline', () => {
  const declined = (throughVersion: number, occurredAt = 200): IndexEvent => ({
    type: 'Declined',
    engagementId: 'e1',
    occurredAt,
    throughVersion,
  });

  it('ignores Declined while an apply is in progress', () => {
    const row = makeRow({ inProgress: { since: 150 } });
    expect(reduce(row, declined(7), TIMEOUT).row).toEqual(row);
  });

  it('keeps a decline made before the apply started even when it is delivered during the apply', () => {
    const events: IndexEvent[] = [
      { type: 'ApplyRequested', engagementId: 'e1', occurredAt: 2, from: 3, to: 7 },
      declined(7, 1), // happened at t=1, delivered late
      { type: 'ApplyFailed', engagementId: 'e1', occurredAt: 3, from: 3, to: 7 },
    ];
    const result = applyAll(makeRow(), events);
    expect(result.declinedThroughVersion).toBe(7);
    expect(result.inProgress).toBeNull();
  });

  it('accepts Declined once the in-progress lock has expired', () => {
    const row = makeRow({ inProgress: { since: 150 } });
    const result = reduce(row, declined(7, 150 + TIMEOUT), TIMEOUT).row;
    expect(result.declinedThroughVersion).toBe(7);
  });

  it('keeps the higher decline when Declined 5 arrives after Declined 7', () => {
    const result = applyAll(makeRow(), [declined(7), declined(5)]);
    expect(result.declinedThroughVersion).toBe(7);
  });

  it('ignores Declined at or below currentVersion', () => {
    const row = makeRow();
    expect(reduce(row, declined(3), TIMEOUT).row).toEqual(row);
  });

  it('records Declined on a row whose currentVersion is unknown', () => {
    const result = reduce(Object.freeze(emptyRow('e1')), declined(7), TIMEOUT).row;
    expect(result.declinedThroughVersion).toBe(7);
  });
});

describe('reduce: load (drift check)', () => {
  const loaded = (version: number, occurredAt: number): IndexEvent => ({
    type: 'EngagementLoaded',
    engagementId: 'e1',
    occurredAt,
    templateId: 't1',
    version,
  });

  it('EngagementLoaded with a different version reports drift and fixes the row without touching declinedThroughVersion', () => {
    const row = makeRow({ declinedThroughVersion: 5 });
    const result = reduce(row, loaded(4, 200), TIMEOUT);
    expect(result.drift).toEqual({ expected: 3, actual: 4 });
    expect(result.row).toEqual({ ...row, currentVersion: 4, versionObservedAt: 200 });
  });

  it('EngagementLoaded with the same version reports no drift', () => {
    const row = makeRow();
    const result = reduce(row, loaded(3, 200), TIMEOUT);
    expect(result.drift).toBeUndefined();
    expect(result.row).toEqual(row);
  });

  it('ignores EngagementLoaded older than versionObservedAt', () => {
    const row = makeRow({ currentVersion: 7, versionObservedAt: 200 });
    const result = reduce(row, loaded(3, 150), TIMEOUT);
    expect(result.drift).toBeUndefined();
    expect(result.row).toEqual(row);
  });

  it('EngagementLoaded on an unknown row makes it known and reports drift with expected null', () => {
    const result = reduce(Object.freeze(emptyRow('e1')), loaded(3, 200), TIMEOUT);
    expect(result.drift).toEqual({ expected: null, actual: 3 });
    expect(result.row).toMatchObject({ templateId: 't1', currentVersion: 3, versionObservedAt: 200 });
  });
});

describe('reduce: lifecycle', () => {
  const removed: IndexEvent = { type: 'EngagementRemoved', engagementId: 'e1', occurredAt: 200, reason: 'deleted' };
  const restore = (occurredAt: number): IndexEvent => ({
    type: 'EngagementCreated',
    engagementId: 'e1',
    occurredAt,
    templateId: 't1',
    version: 3,
    source: 'restore',
  });

  it('ignores events after EngagementRemoved', () => {
    const removedRow = reduce(makeRow(), removed, TIMEOUT).row;
    const later: IndexEvent[] = [
      { type: 'EngagementLoaded', engagementId: 'e1', occurredAt: 300, templateId: 't1', version: 5 },
      { type: 'Declined', engagementId: 'e1', occurredAt: 300, throughVersion: 7 },
      { type: 'ApplyRequested', engagementId: 'e1', occurredAt: 300, from: 3, to: 7 },
      { type: 'EngagementCreated', engagementId: 'e1', occurredAt: 300, templateId: 't1', version: 3, source: 'copy' },
    ];
    expect(applyAll(removedRow, later)).toEqual(removedRow);
  });

  it('EngagementCreated from restore revives a removed row', () => {
    const result = applyAll(makeRow(), [removed, restore(300)]);
    expect(result.removed).toBe(false);
    expect(result.versionObservedAt).toBe(300);
  });

  it('a restore delivered before the older removal stays alive', () => {
    const result = applyAll(makeRow(), [restore(300), removed]);
    expect(result.removed).toBe(false);
  });

  it('ignores a stale restore that happened before the removal', () => {
    const result = applyAll(makeRow(), [removed, restore(150)]);
    expect(result.removed).toBe(true);
  });
});

describe('reduce: replay', () => {
  it('replaying every event twice produces the same final row as applying each once', () => {
    const events: IndexEvent[] = [
      { type: 'EngagementCreated', engagementId: 'e1', occurredAt: 100, templateId: 't1', version: 3, source: 'new' },
      { type: 'Declined', engagementId: 'e1', occurredAt: 200, throughVersion: 5 },
      { type: 'EngagementLoaded', engagementId: 'e1', occurredAt: 250, templateId: 't1', version: 3 },
      { type: 'ApplyRequested', engagementId: 'e1', occurredAt: 300, from: 3, to: 7 },
      { type: 'Declined', engagementId: 'e1', occurredAt: 310, throughVersion: 7 },
      { type: 'ApplySucceeded', engagementId: 'e1', occurredAt: 400, from: 3, to: 7 },
      { type: 'Declined', engagementId: 'e1', occurredAt: 500, throughVersion: 8 },
    ];
    const start = Object.freeze(emptyRow('e1'));
    const once = applyAll(start, events);
    const twice = applyAll(start, events.flatMap((e) => [e, e]));
    expect(twice).toEqual(once);
    expect(once).toMatchObject({ currentVersion: 7, declinedThroughVersion: 8, inProgress: null });
  });
});

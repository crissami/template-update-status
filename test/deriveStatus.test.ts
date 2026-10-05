import { describe, expect, it } from 'vitest';
import { deriveStatus, isLockExpired } from '../src/deriveStatus';
import { emptyRow, type IndexRow } from '../src/types';

const TIMEOUT = 10 * 60_000;
const NOW = 1_000_000;

function makeRow(overrides: Partial<IndexRow> = {}): IndexRow {
  return { ...emptyRow('e1'), templateId: 't1', currentVersion: 3, versionObservedAt: 1, ...overrides };
}

describe('deriveStatus', () => {
  it('returns unknown for a row the index has never seen', () => {
    expect(deriveStatus(emptyRow('e1'), 7, NOW, TIMEOUT)).toEqual({ kind: 'unknown' });
  });

  it('returns pending 3→7 when current is 3, latest is 7 and nothing was declined', () => {
    expect(deriveStatus(makeRow(), 7, NOW, TIMEOUT)).toEqual({ kind: 'pending', from: 3, to: 7 });
  });

  it('rule 4: change summary spans currentVersion→latest, so declined-through-5 with current 3 and latest 7 is pending from 3, not 5', () => {
    const row = makeRow({ declinedThroughVersion: 5 });
    expect(deriveStatus(row, 7, NOW, TIMEOUT)).toEqual({ kind: 'pending', from: 3, to: 7 });
  });

  it('returns declined when declined through the latest version', () => {
    const row = makeRow({ declinedThroughVersion: 7 });
    expect(deriveStatus(row, 7, NOW, TIMEOUT)).toEqual({ kind: 'declined', through: 7 });
  });

  it('becomes pending 3→8 again when a version newer than the decline is published', () => {
    const row = makeRow({ declinedThroughVersion: 7 });
    expect(deriveStatus(row, 8, NOW, TIMEOUT)).toEqual({ kind: 'pending', from: 3, to: 8 });
  });

  it('returns upToDate when current equals latest', () => {
    expect(deriveStatus(makeRow({ currentVersion: 7 }), 7, NOW, TIMEOUT)).toEqual({ kind: 'upToDate' });
  });

  it('returns templateUnknown when the template store does not know the template', () => {
    expect(deriveStatus(makeRow(), undefined, NOW, TIMEOUT)).toEqual({ kind: 'templateUnknown' });
  });

  it('returns inProgress while the apply is within the timeout', () => {
    const row = makeRow({ inProgress: { since: NOW - TIMEOUT + 1 } });
    expect(deriveStatus(row, 7, NOW, TIMEOUT)).toEqual({
      kind: 'inProgress',
      since: NOW - TIMEOUT + 1,
      from: 3,
      to: 7,
    });
  });

  it('treats an apply older than the timeout as expired and returns pending', () => {
    const row = makeRow({ inProgress: { since: NOW - TIMEOUT - 1 } });
    expect(deriveStatus(row, 7, NOW, TIMEOUT)).toEqual({ kind: 'pending', from: 3, to: 7 });
  });

  it('returns removed for a removed row', () => {
    expect(deriveStatus(makeRow({ removed: true }), 7, NOW, TIMEOUT)).toEqual({ kind: 'removed' });
  });
});

describe('isLockExpired', () => {
  it('counts a lock exactly timeoutMs old as expired', () => {
    expect(isLockExpired(NOW - TIMEOUT, NOW, TIMEOUT)).toBe(true);
  });

  it('counts a lock one millisecond younger than timeoutMs as active', () => {
    expect(isLockExpired(NOW - TIMEOUT + 1, NOW, TIMEOUT)).toBe(false);
  });
});

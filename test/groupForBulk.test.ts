import { describe, expect, it } from 'vitest';
import { bulkDecline, groupForBulk, type BulkGroup } from '../src/groupForBulk';
import { emptyRow, type IndexRow } from '../src/types';

const TIMEOUT = 10 * 60_000;
const NOW = 1_000_000;
const LATEST = new Map([['t1', 7]]);

function makeRow(id: string, overrides: Partial<IndexRow> = {}): IndexRow {
  return { ...emptyRow(id), templateId: 't1', currentVersion: 3, versionObservedAt: 1, ...overrides };
}

describe('groupForBulk', () => {
  it('rows on v6 and v3 of the same template form two groups with v6 first', () => {
    const rows = [makeRow('a', { currentVersion: 3 }), makeRow('b', { currentVersion: 6 })];
    const view = groupForBulk(rows, LATEST, NOW, TIMEOUT);
    expect(view.groups.map((g) => [g.from, g.to, g.declinableIds])).toEqual([
      [6, 7, ['b']],
      [3, 7, ['a']],
    ]);
  });

  it('puts in-progress rows in inProgressIds, not declinableIds', () => {
    const rows = [makeRow('a'), makeRow('b', { inProgress: { since: NOW - 1 } })];
    const [group] = groupForBulk(rows, LATEST, NOW, TIMEOUT).groups;
    expect(group.declinableIds).toEqual(['a']);
    expect(group.inProgressIds).toEqual(['b']);
  });

  it('puts unknown rows in unknownIds and leaves up-to-date and declined rows out', () => {
    const rows = [
      emptyRow('unknown'),
      makeRow('upToDate', { currentVersion: 7 }),
      makeRow('declined', { declinedThroughVersion: 7 }),
    ];
    expect(groupForBulk(rows, LATEST, NOW, TIMEOUT)).toEqual({
      groups: [],
      unknownIds: ['unknown'],
      templateUnknownIds: [],
    });
  });

  it('puts rows whose template is missing from the store in templateUnknownIds, not in groups', () => {
    const rows = [makeRow('a'), makeRow('b', { templateId: 'retired' })];
    const view = groupForBulk(rows, LATEST, NOW, TIMEOUT);
    expect(view.templateUnknownIds).toEqual(['b']);
    expect(view.groups.flatMap((g) => g.declinableIds)).toEqual(['a']);
  });

  it('orders groups by templateId, then by from descending within a template', () => {
    const latest = new Map([
      ['t1', 7],
      ['t2', 4],
    ]);
    const rows = [makeRow('a', { templateId: 't2', currentVersion: 1 }), makeRow('b'), makeRow('c', { templateId: 't2' })];
    const view = groupForBulk(rows, latest, NOW, TIMEOUT);
    expect(view.groups.map((g) => [g.templateId, g.from])).toEqual([
      ['t1', 3],
      ['t2', 3],
      ['t2', 1],
    ]);
  });
});

describe('bulkDecline', () => {
  it('emits one Declined per declinable id with throughVersion = to', () => {
    const group: BulkGroup = { templateId: 't1', from: 3, to: 7, declinableIds: ['a', 'b'], inProgressIds: ['c'] };
    expect(bulkDecline(group, NOW)).toEqual([
      { type: 'Declined', engagementId: 'a', occurredAt: NOW, throughVersion: 7 },
      { type: 'Declined', engagementId: 'b', occurredAt: NOW, throughVersion: 7 },
    ]);
  });
});

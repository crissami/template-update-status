import { deriveStatus } from './deriveStatus';
import type { Declined, EngagementId, IndexRow, TemplateId } from './types';

export interface BulkGroup {
  templateId: TemplateId;
  from: number; // shared currentVersion
  to: number; // latest
  declinableIds: EngagementId[]; // pending, not in progress
  inProgressIds: EngagementId[]; // shown but excluded from bulk decline
}

export interface BulkView {
  groups: BulkGroup[]; // per template, sorted by `from` DESC (smallest diff first)
  unknownIds: EngagementId[]; // always rendered last
  templateUnknownIds: EngagementId[]; // no latest version to group by
}

export function groupForBulk(
  rows: IndexRow[],
  latestByTemplate: ReadonlyMap<TemplateId, number>,
  now: number,
  timeoutMs: number,
): BulkView {
  const groups = new Map<string, BulkGroup>();
  const unknownIds: EngagementId[] = [];
  const templateUnknownIds: EngagementId[] = [];

  for (const row of rows) {
    const latest = row.templateId === null ? undefined : latestByTemplate.get(row.templateId);
    const status = deriveStatus(row, latest, now, timeoutMs);

    if (status.kind === 'unknown') {
      unknownIds.push(row.engagementId);
    } else if (status.kind === 'templateUnknown') {
      templateUnknownIds.push(row.engagementId);
    } else if ((status.kind === 'pending' || status.kind === 'inProgress') && row.templateId !== null) {
      const group = getOrCreateGroup(groups, row.templateId, status.from, status.to);
      const ids = status.kind === 'pending' ? group.declinableIds : group.inProgressIds;
      ids.push(row.engagementId);
    }
    // removed, upToDate and declined rows are not part of the bulk view.
  }

  return { groups: [...groups.values()].sort(compareGroups), unknownIds, templateUnknownIds };
}

function getOrCreateGroup(groups: Map<string, BulkGroup>, templateId: TemplateId, from: number, to: number): BulkGroup {
  const key = `${templateId}\u0000${from}`;
  let group = groups.get(key);
  if (!group) {
    group = { templateId, from, to, declinableIds: [], inProgressIds: [] };
    groups.set(key, group);
  }
  return group;
}

// templateId ascending, then from descending (smallest diff first).
// The real UI sorts templates by display name; ids keep this slice deterministic.
function compareGroups(a: BulkGroup, b: BulkGroup): number {
  if (a.templateId !== b.templateId) return a.templateId < b.templateId ? -1 : 1;
  return b.from - a.from;
}

export function bulkDecline(group: BulkGroup, now: number): Declined[] {
  return group.declinableIds.map((engagementId) => ({
    type: 'Declined',
    engagementId,
    occurredAt: now,
    throughVersion: group.to,
  }));
}

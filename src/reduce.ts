import { isLockExpired } from './deriveStatus';
import type {
  ApplyFailed,
  ApplyRequested,
  ApplySucceeded,
  Declined,
  EngagementCreated,
  EngagementLoaded,
  EngagementRemoved,
  IndexEvent,
  IndexRow,
} from './types';

export interface Drift {
  expected: number | null;
  actual: number;
}

export interface ReduceResult {
  row: IndexRow;
  drift?: Drift;
}

// Pure: returns a new row (or the same row when the event is a no-op), never mutates.
export function reduce(row: IndexRow, event: IndexEvent, inProgressTimeoutMs: number): ReduceResult {
  // Removed rows ignore everything except a restore (late events for a deleted file).
  if (row.removed && !(event.type === 'EngagementCreated' && event.source === 'restore')) {
    return { row };
  }

  switch (event.type) {
    case 'EngagementCreated':
      return { row: onCreated(row, event) };
    case 'EngagementLoaded':
      return onLoaded(row, event);
    case 'ApplyRequested':
      return { row: onApplyRequested(row, event, inProgressTimeoutMs) };
    case 'ApplySucceeded':
      return { row: onApplySucceeded(row, event) };
    case 'ApplyFailed':
      return { row: onApplyFailed(row, event) };
    case 'Declined':
      return { row: onDeclined(row, event, inProgressTimeoutMs) };
    case 'EngagementRemoved':
      return { row: onRemoved(row, event) };
  }
}

// versionObservedAt is the time of the last version or lifecycle change on this row.
function isStale(row: IndexRow, occurredAt: number): boolean {
  return row.versionObservedAt !== null && occurredAt < row.versionObservedAt;
}

function isLocked(row: IndexRow, at: number, timeoutMs: number): boolean {
  return row.inProgress !== null && !isLockExpired(row.inProgress.since, at, timeoutMs);
}

function onCreated(row: IndexRow, event: EngagementCreated): IndexRow {
  // Out-of-order: a create/restore older than the last version or lifecycle change.
  if (isStale(row, event.occurredAt)) return row;
  // declinedThroughVersion and inProgress are kept: the index is the system of record
  // for declines, and max() in the reference point makes an old decline harmless.
  return {
    ...row,
    templateId: event.templateId,
    currentVersion: event.version,
    versionObservedAt: event.occurredAt,
    removed: false,
  };
}

function onLoaded(row: IndexRow, event: EngagementLoaded): ReduceResult {
  // Stale: a load that started before an apply finished reports the old version.
  if (isStale(row, event.occurredAt)) return { row };
  // Duplicate or no drift: the file matches what the index already believes.
  if (event.version === row.currentVersion) return { row };
  // Never touches declinedThroughVersion: the file does not know about declines.
  return {
    row: {
      ...row,
      templateId: event.templateId,
      currentVersion: event.version,
      versionObservedAt: event.occurredAt,
    },
    drift: { expected: row.currentVersion, actual: event.version },
  };
}

function onApplyRequested(row: IndexRow, event: ApplyRequested, timeoutMs: number): IndexRow {
  // Out-of-order or stale: the request was made against a version the row is no longer on.
  if (event.from !== row.currentVersion) return row;
  // Race or duplicate: another apply already holds an unexpired lock.
  if (isLocked(row, event.occurredAt, timeoutMs)) return row;
  return { ...row, inProgress: { since: event.occurredAt } };
}

function onApplySucceeded(row: IndexRow, event: ApplySucceeded): IndexRow {
  // Race: a load already reported `to` before this success arrived; only the lock is left to clear.
  if (event.to === row.currentVersion) return clearLockStartedBy(row, event.occurredAt);
  // Out-of-order: from no longer matches the version the row is on.
  // Deliberately not gated by the lock, so a late success after expiry still lands.
  if (event.from !== row.currentVersion) return row;
  return {
    ...row,
    currentVersion: event.to,
    declinedThroughVersion: 0,
    inProgress: null,
    versionObservedAt: event.occurredAt,
  };
}

function clearLockStartedBy(row: IndexRow, occurredAt: number): IndexRow {
  // Duplicate: lock already cleared, so a redelivered success is a no-op.
  if (row.inProgress === null) return row;
  // Out-of-order: the lock belongs to a newer apply that started after this success.
  if (row.inProgress.since > occurredAt) return row;
  return { ...row, inProgress: null };
}

function onApplyFailed(row: IndexRow, event: ApplyFailed): IndexRow {
  // Out-of-order: a failure for an apply from a version the row has already left.
  if (event.from !== row.currentVersion) return row;
  // Duplicate: lock already cleared.
  if (row.inProgress === null) return row;
  return { ...row, inProgress: null };
}

function onDeclined(row: IndexRow, event: Declined, timeoutMs: number): IndexRow {
  // Race: another user is applying; declining during it would contradict that apply.
  // A decline that happened before the apply started is delivered late, not racing, so it is kept.
  const startedBeforeLock = row.inProgress !== null && event.occurredAt < row.inProgress.since;
  if (!startedBeforeLock && isLocked(row, event.occurredAt, timeoutMs)) return row;
  // Out-of-order: decline of versions the row has already moved past.
  // When currentVersion is unknown the decline is kept; the UI never offers decline
  // on unknown rows, so this only happens via a late or replayed event.
  if (row.currentVersion !== null && event.throughVersion <= row.currentVersion) return row;
  // Duplicate or out-of-order: an equal or higher decline is already recorded.
  if (event.throughVersion <= row.declinedThroughVersion) return row;
  return { ...row, declinedThroughVersion: event.throughVersion };
}

function onRemoved(row: IndexRow, event: EngagementRemoved): IndexRow {
  // Out-of-order: a removal older than a restore that has already been applied.
  if (isStale(row, event.occurredAt)) return row;
  return { ...row, removed: true, versionObservedAt: event.occurredAt };
}

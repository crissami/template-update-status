import type { IndexRow, Status } from './types';

// One definition of "expired" shared by reduce and deriveStatus, so the dashboard
// never offers an action that the reducer would then silently ignore.
export function isLockExpired(since: number, at: number, timeoutMs: number): boolean {
  return at - since >= timeoutMs;
}

export function deriveStatus(
  row: IndexRow,
  latestVersion: number | undefined,
  now: number,
  inProgressTimeoutMs: number,
): Status {
  if (row.removed) return { kind: 'removed' };
  if (row.currentVersion === null) return { kind: 'unknown' };

  // Template missing from the template store (not yet synced, or retired): we cannot
  // name a target version, so we report that instead of guessing pending or upToDate.
  if (latestVersion === undefined) return { kind: 'templateUnknown' };

  const current = row.currentVersion;

  // Race: another user already started an apply. Expired locks fall through so a
  // crashed apply does not hide the update forever.
  if (row.inProgress && !isLockExpired(row.inProgress.since, now, inProgressTimeoutMs)) {
    return { kind: 'inProgress', since: row.inProgress.since, from: current, to: latestVersion };
  }

  if (latestVersion <= current) return { kind: 'upToDate' };
  if (latestVersion <= row.declinedThroughVersion) {
    return { kind: 'declined', through: row.declinedThroughVersion };
  }

  // Rule 4: from is ALWAYS currentVersion. Declining changes no content, so the
  // change summary must cover everything between current and latest.
  return { kind: 'pending', from: current, to: latestVersion };
}

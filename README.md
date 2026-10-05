# Template update status (Part 2 slice)

This is the pure logic over the engagement index. It decides which engagements have a pending template update and lets users apply or decline it. There is no I/O, database, HTTP or UI here.

| File | Purpose |
| --- | --- |
| `src/types.ts` | Index row, event union, `Status`, `emptyRow` |
| `src/reduce.ts` | `reduce(row, event, timeoutMs)`: folds one event into a row; reports drift |
| `src/deriveStatus.ts` | `deriveStatus(...)` and the shared `isLockExpired(...)` |
| `src/groupForBulk.ts` | `groupForBulk(...)` for the bulk view, `bulkDecline(...)` |
| `src/coverage.ts` | `checkCoverage(...)`: validates a summary against the diff |

## Running

Requires Node 20+.

```sh
npm install
npx vitest run      # tests
npx tsc --noEmit    # strict typecheck (vitest does not typecheck)
```

## Decisions agreed during review

1. **Lock expiry is shared.** `reduce` takes `inProgressTimeoutMs`, and both `reduce` and `deriveStatus` call `isLockExpired(since, at, timeoutMs)` (`at - since >= timeoutMs`). `reduce` measures against the event's `occurredAt` and `deriveStatus` against `now`. `ApplySucceeded` and `ApplyFailed` are gated only by `from === currentVersion`, never by the lock, so a late success still lands after the lock has expired.
2. **`versionObservedAt` now means "last version or lifecycle change".** It is set by `EngagementCreated`, `EngagementLoaded` (on drift), `ApplySucceeded` **and `EngagementRemoved`**. Because it is one timestamp, a removal older than an applied restore is ignored, and so is a restore older than an applied removal.
3. **`EngagementCreated` on an existing row** sets only `templateId`, `currentVersion`, `versionObservedAt` and `removed`. It leaves `declinedThroughVersion` and `inProgress` unchanged. On a removed row, only `source: 'restore'` is accepted.
4. **`Declined` on an unknown row is recorded.** The UI never offers decline on unknown rows, so this only happens through a late or replayed event, and dropping it would lose a decline.
5. **Bulk groups are sorted by `templateId` ascending, then `from` descending.** The real UI sorts by template display name.
6. **Only declines made *during* a lock are dropped.** A `Declined` with `occurredAt < inProgress.since` happened before the apply started and was merely delivered late, so it is recorded. It survives an `ApplyFailed`. A successful apply resets it to 0 as usual.
7. **`ApplySucceeded` runs three checks in order.** (1) If `currentVersion === to`, it clears `inProgress` only, even when the event is stale. This covers a load that reported the new version before the success arrived, and is idempotent: once the lock is clear, a redelivered success is a no-op. (2) If `isStale`, it is ignored, which stops an old success from re-applying after a restore. (3) If `from === currentVersion`, it applies.
8. **Drift carries `duringApply: boolean`.** It is `true` when a lock was held at the load's `occurredAt` and the load happened at or after the lock started. Drift is flagged, never suppressed.
9. **`EngagementLoaded` with a different `templateId` is accepted.** It resets `declinedThroughVersion` to 0 and reports `drift.kind = 'templateChanged'` (otherwise `'versionChanged'`). This is a deliberate exception to rule 7, commented in code: declines refer to the old template's versions.
10. **`templateUnknown` status.** A template missing from the store is reported as `templateUnknown`, not `upToDate`. `groupForBulk` lists these rows in `templateUnknownIds` and never in groups.
11. **`EngagementRemoved` clears `inProgress`.**

## Assumptions (not in the original spec)

- Events have a `type` discriminant.
- `Status` is in `types.ts` because two modules use it. The bulk and coverage types live next to the functions that use them. `latestByTemplate` is a `ReadonlyMap`, so a missing template is honestly typed as `undefined`.
- **Equal timestamps are not stale.** `isStale` uses `occurredAt < versionObservedAt`. Re-applying an event with the same timestamp writes the same values again, so it is idempotent.
- `EngagementLoaded` with the same version is a complete no-op and does not move `versionObservedAt` forward.
- `deriveStatus` checks in this order: removed, unknown, `templateUnknown`, active lock (→ `inProgress`), `upToDate`, `declined`, `pending`. An unknown row whose template is also missing from the store is `unknown`.
- `duringApply` and late declines use the same helper, `isLockHeldAt`: lock present, event at or after `since`, not expired. `ApplyRequested` keeps the plain `isLocked` check.
- `templateChanged` leaves `inProgress` alone. Drift reports versions only, not template ids.
- Decision 7, check 1 only clears a lock that started at or before the success's `occurredAt`. Without this, a redelivered old `ApplySucceeded{3→7}` would clear the lock of a *newer* apply (7→9) running on the same row. It has its own test.
- Decision 7, check 1 clears only the lock. It does not reset `declinedThroughVersion`. Any decline left over is at or below `to`, so max() in the reference point makes it harmless.
- `groupForBulk` groups by `(templateId, from)`. A group can contain only `inProgressIds`. `unknownIds` keep input order.
- `bulkDecline` uses `now` as each event's `occurredAt`.
- `checkCoverage` removes duplicate ids and keeps first-seen order. An empty diff with no references counts as covered.
- `typescript` is a dev dependency so `tsc --noEmit` can run.

## Open questions (not built)

1. **Correlate applies with an `applyId`.** An `ApplyRequested` delivered after its own `ApplyFailed` takes the lock again until it times out. A correlation id on request, success and failure would let `reduce` recognise the late request as already finished.
2. **Use a per-engagement revision number instead of `occurredAt`.** Every ordering guard compares timestamps from different producers: the engagement system, the apply worker and the template store. Clock skew between them can make a fresh event look stale. A monotonically increasing revision per engagement, assigned by one writer, would make ordering exact.
3. **`Declined.throughVersion` is validated at the API boundary.** The decline endpoint rejects a `throughVersion` above the latest published version. `reduce` treats events as facts that already happened, so it does not re-validate them.
4. **A template change during an apply.** The lock taken for the old template's apply is left in place and only clears when it times out.

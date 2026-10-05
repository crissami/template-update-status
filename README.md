# Template update status (Part 2 slice)

This is the pure logic over the engagement index. It decides which engagements have a pending template update, tracks the outcome of applies, and produces bulk declines. There is no I/O, database, HTTP or UI here.

| File                  | Purpose                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `src/types.ts`        | Index row, event union, `Status`, `emptyRow`                               |
| `src/reduce.ts`       | `reduce(row, event, timeoutMs)`: folds one event into a row; reports drift |
| `src/deriveStatus.ts` | `deriveStatus(...)` and the shared `isLockExpired(...)`                    |
| `src/groupForBulk.ts` | `groupForBulk(...)` for the bulk view, `bulkDecline(...)`                  |
| `src/coverage.ts`     | `checkCoverage(...)`: validates a summary against the diff                 |

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
6. **Only declines made _during_ a lock are dropped.** A `Declined` with `occurredAt < inProgress.since` happened before the apply started and was merely delivered late, so it is recorded. It survives an `ApplyFailed`. A successful apply resets it to 0 as usual.
7. **`ApplySucceeded` runs three checks in order.** (1) If `currentVersion === to`, it clears `inProgress` only, and only if the lock started at or before the success's `occurredAt` (this check runs even when the event is otherwise stale). This covers a load that reported the new version before the success arrived, without letting an old success clear the lock of a newer apply. It is idempotent: once the lock is clear, a redelivered success is a no-op. (2) If `isStale`, it is ignored, which stops an old success from re-applying after a restore. (3) If `from === currentVersion`, it applies.
8. **Drift carries `duringApply: boolean`.** It is `true` when a lock was held at the load's `occurredAt` and the load happened at or after the lock started. Drift is flagged, never suppressed.
9. **`EngagementLoaded` with a different `templateId` is accepted.** It resets `declinedThroughVersion` to 0 and reports `drift.kind = 'templateChanged'` (otherwise `'versionChanged'`). This is a deliberate exception to "a load never changes declines", commented in code: the declines refer to the old template's versions.
10. **`templateUnknown` status.** A template missing from the store is reported as `templateUnknown`, not `upToDate`. `groupForBulk` lists these rows in `templateUnknownIds` and never in groups.
11. **`EngagementRemoved` clears `inProgress`.**

## Assumptions

### Types

- Events have a `type` discriminant.
- `Status` lives in `types.ts` because two modules use it. Bulk and coverage types live next to the functions that use them.
- `latestByTemplate` is a `ReadonlyMap`, so a missing template is typed as `undefined`.

### Event handling (`reduce`)

- Equal timestamps are not stale: `isStale` uses `occurredAt < versionObservedAt`. Re-applying an event with the same timestamp writes the same values, so it is idempotent.
- `EngagementLoaded` with the same version is a no-op and does not move `versionObservedAt` forward.
- `duringApply` and late declines use one helper, `isLockHeldAt`: lock present, event at or after `since`, not expired. `ApplyRequested` uses the plain `isLocked` check.
- `ApplySucceeded` when the row is already at `to`:
  - clears the lock only if the lock started at or before the success's `occurredAt`. Otherwise a redelivered old `ApplySucceeded{3→7}` would clear the lock of a newer apply (7→9). Covered by its own test.
  - does not reset `declinedThroughVersion`. Any remaining decline is at or below `to`, so max() in the reference point makes it harmless.
- A template change on load (`templateChanged`) leaves `inProgress` alone. Drift reports versions, not template ids.

### Status and grouping

- `deriveStatus` checks in this order: removed, unknown, `templateUnknown`, active lock (`inProgress`), `upToDate`, `declined`, `pending`. An unknown row whose template is also missing is `unknown`.
- `groupForBulk` groups by `(templateId, from)`. A group can contain only `inProgressIds`. `unknownIds` keep input order.
- `bulkDecline` uses `now` as each event's `occurredAt`.

### Coverage

- `checkCoverage` removes duplicate ids, keeping first-seen order. An empty diff with no references counts as covered.

### Tooling

- `typescript` is a dev dependency so `tsc --noEmit` can run.

## Open questions (not built)

1. **Correlate applies with an `applyId`.** An `ApplyRequested` delivered after its own `ApplyFailed` takes the lock again until it times out. A correlation id on request, success and failure would let `reduce` recognise the late request as already finished.
2. **Use a per-engagement revision number instead of `occurredAt`.** Every ordering guard compares timestamps from different producers: the engagement system, the apply worker and the template store. Clock skew between them can make a fresh event look stale. A monotonically increasing revision per engagement, assigned by one writer, would make ordering exact.
3. **Validate `Declined.throughVersion` at the API boundary.** The decline endpoint (not part of this slice) should reject a `throughVersion` above the latest published version. `reduce` treats events as facts that already happened, so it does not re-validate them.
4. **A template change during an apply.** The lock taken for the old template's apply is left in place and only clears when it times out.

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
7. **`ApplySucceeded` with `currentVersion === to` clears `inProgress`.** This covers a load that reported the new version before the success message arrived. It is still idempotent: once the lock is clear, a redelivered success is a no-op.

## Assumptions (not in the original spec)

- Events have a `type` discriminant.
- `Status` is in `types.ts` because two modules use it. The bulk and coverage types live next to the functions that use them. `latestByTemplate` is a `ReadonlyMap`, so a missing template is honestly typed as `undefined`.
- **Equal timestamps are not stale.** `isStale` uses `occurredAt < versionObservedAt`. Re-applying an event with the same timestamp writes the same values again, so it is idempotent.
- `EngagementLoaded` with the same version is a complete no-op and does not move `versionObservedAt` forward.
- `deriveStatus` checks in this order: removed, unknown, template unknown to the store (→ `upToDate`), active lock (→ `inProgress`), `upToDate`, `declined`, `pending`.
- Decision 7 only clears a lock that started at or before the success's `occurredAt`. Without this, a redelivered old `ApplySucceeded{3→7}` would clear the lock of a *newer* apply (7→9) running on the same row. It has its own test.
- Decision 7 clears only the lock. It does not reset `declinedThroughVersion`. Any decline left over is at or below `to`, so max() in the reference point makes it harmless.
- `groupForBulk` groups by `(templateId, from)`. A group can contain only `inProgressIds`. `unknownIds` keep input order.
- `bulkDecline` uses `now` as each event's `occurredAt`.
- `checkCoverage` removes duplicate ids and keeps first-seen order. An empty diff with no references counts as covered.
- `typescript` is a dev dependency so `tsc --noEmit` can run.

## Open questions (not built)

1. **`ApplySucceeded` has no timestamp guard.** Suppose an engagement is restored back to v3 after an apply 3→7, and then the old `ApplySucceeded{3→7}` is redelivered. It matches `from === currentVersion` and re-applies. Adding `isStale` to that branch would close this.
2. **Suppress drift while locked.** A load that reports the apply's result before `ApplySucceeded` arrives (`EngagementLoaded{7}` during apply 3→7) raises a false drift alarm. The lock part is fixed (decision 7). Whether to suppress or tag drift while a lock is held is still open.
3. **`ApplyRequested` delivered after its own `ApplyFailed`** takes the lock again until the timeout. Requests have no id that would let us match them to their outcome.
4. **Clock skew.** `occurredAt` comes from different producers: the engagement system, the apply worker and the template store. Every ordering guard assumes their clocks are comparable.
5. **The template changes under a load.** `EngagementLoaded` with a different `templateId` simply overwrites it. Is that a valid transition, or an alert?
6. **`Declined.throughVersion` above the latest published version** is accepted without a check.
7. **A template unknown to the store** shows as `upToDate`. A distinct `templateUnknown` status would make that state visible instead of hiding it.
8. `EngagementRemoved` does not clear `inProgress`. After a restore, the old lock still applies until it expires.

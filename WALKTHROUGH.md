# Walkthrough

## The idea in one paragraph

Loading an engagement file takes about a minute, so the dashboard never opens files. Instead, a small row per engagement (the **index**) is kept up to date from events. Each event is folded in by `reduce`. `deriveStatus` turns a row plus the template's latest version into what the user sees. Events can be duplicated and can arrive out of order, so every branch of `reduce` either proves the event is still relevant or does nothing.

## Functions

### `reduce(row, event, timeoutMs)`
This takes the current row and one event, and returns a new row. It never edits the input. When the event is an `EngagementLoaded` showing a version different from what the index believed, it also returns `drift`. **Design decision:** the index is the system of record for declines, and the file is the system of record for the version. A load can correct the version but never touches declines.

### `deriveStatus(row, latest, now, timeoutMs)`
This turns a row into one of six statuses. Pending means `latest > max(current, declinedThrough)`, and the `from` it reports is **always** `currentVersion`. **Design decision:** a decline hides an update without changing any content, so the change summary must still span everything since the version the file is actually on.

### `isLockExpired(since, at, timeoutMs)`
This returns `true` when `at - since >= timeoutMs`. **Design decision:** a single definition shared by `reduce` and `deriveStatus`. If they disagreed, the dashboard would show "pending" and offer Decline, and the reducer would silently drop that decline.

### `groupForBulk(rows, latestByTemplate, now, timeoutMs)`
This groups pending rows by template and current version, so one bulk action covers engagements that would see the same change summary. In-progress rows are shown but cannot be declined. Unknown rows go in a separate list rendered last. **Design decision:** groups are sorted by `from` descending, so the smallest and safest diffs come first. Grouping by `from` (not only by template) keeps the change summary identical within a group.

### `bulkDecline(group, now)`
This turns a group into one `Declined` event per declinable engagement, each with `throughVersion = group.to`. **Design decision:** a bulk action is just N ordinary events, so `reduce` needs no bulk-specific logic and each decline is still individually guarded.

### `checkCoverage(diffItemIds, sentences)`
This compares the ids a summary cites with the ids in the deterministic diff. It reports diff items nobody mentioned (`missing`) and cited ids that do not exist (`unknownRefs`). **Design decision:** the diff is the truth and the summary is only a view of it. Any summary, whether from an LLM or a human, is checked rather than trusted.

## Guards in `reduce` and what triggers them

| Guard | Real-world scenario |
| --- | --- |
| Removed row ignores everything except a restore | A user deletes an engagement while a load or decline message is still in the queue; SQS then delivers it. |
| `isStale` on `EngagementCreated` | A restore from an old backup arrives after a newer removal or apply was already processed. |
| `isStale` on `EngagementLoaded` | User A opens the file at 10:00, and the load takes a minute. User B's apply finishes at 10:00:30. A's load event (v3, stamped 10:00) arrives after the apply (v7) and must not roll the row back. |
| `EngagementLoaded` with the same version is a no-op | Every ordinary file open. It is also the message redelivered after a consumer timeout. |
| `ApplyRequested`: `from !== currentVersion` | A user clicks Apply on a stale dashboard after someone else already applied. |
| `ApplyRequested`: lock active | Two users click Apply at the same moment, or the request message is redelivered. |
| `ApplySucceeded`: `currentVersion === to` → clear lock only | User C opened the file while user A's apply was finishing. C's load reported v7 before A's success message arrived. The version is already right; only the lock is left. |
| …but not if the lock started after the success | An old success is redelivered while a *newer* apply (7→9) holds the lock. Clearing it would let a second user start a concurrent apply. |
| `ApplySucceeded`: `currentVersion === to` with no lock | SQS redelivers the success after a visibility timeout. The row is already at `to` and unlocked, so the duplicate does nothing. |
| `ApplySucceeded`: `from !== currentVersion` | An old success (for example 1→3) is delivered after the row moved on to a different version. |
| `ApplySucceeded` not gated by the lock | The apply worker was slow and the lock expired, but the file *was* updated. Ignoring the success would leave the index permanently wrong. |
| `ApplyFailed`: `from !== currentVersion` | A failure from an earlier attempt arrives after a later attempt succeeded. |
| `ApplyFailed`: lock already clear | A redelivered failure message. |
| `Declined`: lock active, and decline happened at or after `since` | User B declines while user A's apply is running. B's view was stale. |
| …but kept if it happened before `since` | User B declined at 10:00. The message was delayed, and user A started an apply at 10:01 that later failed. B's decision is real and must survive the failure. |
| `Declined`: `throughVersion <= currentVersion` | A decline sent before an apply is delivered after it. It refers to versions the file has already moved past. |
| `Declined`: `throughVersion <= declinedThroughVersion` | "Decline through 5" arrives after "decline through 7" (out of order), or the same decline is redelivered. |
| `isStale` on `EngagementRemoved` | An engagement was deleted and then restored, and the delete message is delayed behind the restore. |

## The two tests that matter most

**"rule 4: … pending from 3, not 5"** (`deriveStatus.test.ts`). This is the bug most likely to ship. Reporting `from: declinedThroughVersion` looks reasonable, passes a happy-path demo, and produces a nice small diff. It is wrong: the file is still on v3, so applying v7 changes v4, v5, v6 and v7. A summary that starts at v5 would hide changes from an auditor who is about to sign off on the file.

**"replaying every event twice produces the same final row…"** (`reduce.test.ts`). At-least-once delivery means every event *will* be duplicated eventually in production. This one test exercises the duplicate guard of every branch together, including the interaction between lock, decline and apply. If any branch is not idempotent (for example, it toggles something or adds to a counter), the final row diverges.

## Where I would not trust AI-generated code here

These are places where a subtle error is invisible in a demo and wrong in production:

- **The `from` version.** `from: max(current, declined)` or `from: declined` reads naturally and every happy-path test still passes. Only test 3 catches it.
- **Comparison operators in the guards.** `<` versus `<=` in `isStale`, `isLockExpired` and the decline checks. Off-by-one at a timestamp or version boundary only fails under the exact race it was meant to stop. `isLockExpired` has explicit boundary tests for this reason.
- **The lock defined in two places.** Generated code tends to write `row.inProgress !== null` in the reducer and a timeout check in the view. The result is a UI that offers actions the backend ignores. One shared helper prevents that.
- **Comparisons with `null`.** In JavaScript, `5 <= null` is `false` and `0 <= null` is `true` (null becomes 0). An unguarded `throughVersion <= row.currentVersion` behaves unpredictably for unknown rows. The explicit `!== null` check is deliberate.
- **Drift touching declines.** It is tempting to "reset" the row when a load reports a new version. That would quietly erase declines, which exist nowhere except the index.
- **Mutation.** A reducer that edits `row` in place passes most equality tests, because the "before" and "after" objects are the same reference. The tests freeze their input rows so mutation throws.
- **The cases the tests do not cover.** These are listed under Open questions in the README. A green suite only means the guarded scenarios work, not that every ordering is safe.

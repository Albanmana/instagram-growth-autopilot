# Four-hour balanced cadence and operational timeline design

## Goal

Make the local Instagram follow-up autopilot predictable and bounded:

- run one global follow-up cycle every four hours;
- review relationship state before selecting actions;
- execute up to 50 eligible unfollows, then up to 50 follows;
- never exceed 1,000 active follows; and
- show both durable schedule facts and clearly-labelled projections for the next 48 hours.

The product remains local-only. The dashboard reports state and schedule; it never sends an Instagram action itself.

## Terms

- **Active follow**: a candidate in `followed`, `pending_unfollow`, or the equivalent durable in-flight state. This is the stock measured against the 1,000 cap.
- **Cycle**: one persisted global window, due every four hours. Its action lane remains serial: Instagram actions never overlap.
- **Relationship review**: collection of the current followers of the authenticated account, used to decide whether a followed candidate is a follow-back.
- **Eligible unfollow**: a followed candidate that either (a) was observed as a follow-back in a completed review, or (b) has not followed back and has reached 48 hours since `followedAt` after a completed review.
- **Certain schedule**: work with a persisted, valid deadline or active batch in follow-up state.
- **Projection**: a calculation from the persisted state and settings that may change after a review, Instagram error, pause, or recovery condition.

## Scheduling model

### Four-hour cycle

When autopilot is enabled, the engine schedules the next cycle at a fixed four-hour cadence. A normal cycle executes in this order:

1. Perform the relationship review.
2. Promote at most the eligible unfollows discovered by that review or already due from a completed prior review.
3. Execute up to 50 unfollows, serially, preserving the existing action delay and outcome logging.
4. Recompute the active-follow stock.
5. If the stock is below 1,000, execute up to 50 follows, serially.
6. Persist the following four-hour deadline, or a safe retry/deadline when a review or action cannot complete.

Unfollows always precede follows. A failure must not silently make an item eligible; it stays explicit in history and follows the existing safe retry/recovery path.

### Eligibility rules

Each successful follow records `followedAt`.

- If a completed review finds the handle among the account's followers, mark it `confirmed` and make it eligible for unfollow in that same cycle.
- If the review does not find a follow-back, retain the candidate until `followedAt + 48 hours`. It becomes eligible only after a completed review at or after that timestamp.
- An incomplete/failed follower scan is non-authoritative: it creates no new unfollow eligibility.

This replaces the previous post-follow-back seven-day hold. No candidate can be unfollowed ten minutes after a follow solely because its review was incomplete or absent.

### Capacity and cap

At 50 follows every four hours, the nominal intake is 300 follows/day. Before the first 48-hour eligibility point, the expected active-follow stock is approximately 600–675 candidates, depending on the cycle boundary. The 1,000 cap provides a recovery margin.

If active follows are at or above 1,000 after unfollows, the cycle skips follows. Relationship reviews and eligible unfollows still run until the stock falls below the cap. If more than 50 unfollows are due, the excess remains queued and takes priority in the next cycle; follows remain blocked while unfollow pressure or the cap requires it.

Source rescans remain conditional backlog maintenance. They do not override the four-hour action cycle or cause independent Instagram actions to run concurrently.

## Operational timeline UI

The existing `Next global work` card becomes a single chronological timeline. It is rendered only from the persisted state plus deterministic calculations; UI timers do not schedule work.

### Certain entries: `Programmé`

The timeline shows, in order:

- current in-progress operation, if any;
- the next persisted cycle deadline and absolute local time;
- active batch type, first target, and a short ordered preview when an action batch is already selected;
- a persisted source scan or relationship review deadline; and
- recent executed cycle outcome, including follows, unfollows, skips, and errors.

The first scheduled action shows a live countdown while the panel is visible. If a deadline is due but an action is waiting for the single lane, it reads `Prêt dans la file globale` rather than a fabricated zero-second countdown.

### Calculated entries: `Prévision`

For the next 48 hours, the timeline groups projections by cycle and labels them visibly as forecasts:

- count of accounts that will reach 48 hours before or at each cycle;
- estimated eligible unfollows, bounded by the 50-action cycle capacity;
- whether the follow lot is expected to be full, limited by the cap, or skipped;
- projected active-follow stock and the `active / 1,000` ceiling; and
- the next source rescan only when its backlog condition makes it eligible.

The UI never labels a handle as a certain future unfollow before a completed relationship review. It may say `up to N accounts reach the 48 h review point`.

### States

- **Running**: identifies the real operation and suppresses an invented duration.
- **Scheduled**: shows countdown and local timestamp from the persisted deadline.
- **Ready**: describes work waiting for the global lane.
- **Paused, stopped, recovery required, or local service unavailable**: explains why the calendar is not executing and retains historical information without claiming future execution.

## Data and implementation boundaries

- Persist a dedicated four-hour cycle deadline rather than deriving safety-critical execution from panel render time.
- Persist cycle outcome summaries needed by the timeline, or derive them from durable history without inventing state.
- Keep all follow/unfollow ordering in the background engine; the side panel is read-only regarding schedule selection.
- Preserve MV3 recovery fences, leases, external-operation records, and no-concurrent-action invariant.
- Preserve user-selected settings through migrations; safely migrate old defaults to the new cadence only where they have not been explicitly customized.

## Verification

Automated coverage must prove:

1. Four-hour cycle scheduling survives service-worker restart and does not allow early wake execution.
2. A completed follow-back review makes a confirmed follow-back eligible in that cycle.
3. A non-follow-back does not become eligible before `followedAt + 48 hours`, and an incomplete review cannot promote it.
4. At most 50 unfollows and then at most 50 follows are selected per cycle.
5. At/above the 1,000 active-follow cap, follows are skipped while due unfollows continue.
6. The timeline separates persisted `Programmé` entries from `Prévision` entries, reports exact time/countdown only when justified, and reflects paused/recovery states without false promises.
7. The complete unit suite and existing extension E2E contract pass with no Instagram activity during verification.

Manual acceptance requires reloading the unpacked extension, observing the four-hour calendar and active-stock cap in the side panel, and confirming that no Instagram action is triggered merely by viewing it.

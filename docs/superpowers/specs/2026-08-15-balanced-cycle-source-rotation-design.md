# Balanced cycle source rotation

## Goal

Every four-hour balanced autopilot cycle must refresh the candidate stock instead
of repeating an empty follow-back review forever. A source collection is therefore
mandatory for every cycle, even when pending follow candidates already exist.

## Cycle contract

Each due cycle uses one persisted, serial action lane in this order:

1. Review follow-backs.
2. Collect one configured source.
3. Unfollow up to the configured batch size, but only candidates already eligible
   under the existing 48-hour / verified-follow-back rules.
4. Follow up to the configured batch size from the durable queue.
5. Persist the next cycle four hours later.

The collection chooses exactly one source per cycle. With multiple configured
sources, selection is fair and deterministic: the source least recently collected
is chosen, with durable list order as the tie-breaker. The normal six-hour
automatic-rescan eligibility threshold does not suppress this explicit per-cycle
collection.

## State and recovery

The existing `run.cycle` record gains a `collect` stage between `review` and
`unfollow`. The selected source is persisted through the existing
`sourceScanSourceId` field before collection begins, so an MV3 restart resumes or
retries the same stage rather than skipping it. A collection error is recorded on
the source and retains the requested source for the ordinary retry cadence; it
does not jump straight to follow actions.

Existing safety deadlines, active batches, worker leases, and the recovery fence
remain authoritative. The manual “Run next cycle now” button advances the cycle
deadline only; it still enters this full sequence and cannot bypass a live action
or safety wait.

## UI and verification

The calendar and “Next global work” text describe the expanded order: review,
collect, unfollows, then follows. While the collection is active, the existing
live scan state is shown rather than an invented countdown.

Regression coverage proves:

- a due cycle collects despite a non-empty follow queue;
- sources rotate fairly across successive cycles;
- a restarted worker preserves the required collection stage;
- a source collection failure retries before action batches;
- the manual cycle button follows the same collection-first route.

The full unit suite, relational state tests, and both MV3 E2E modes must pass.
The unpacked extension must then be reloaded and Chrome must expose its successful
reload confirmation. No live Instagram action is needed to validate this change.

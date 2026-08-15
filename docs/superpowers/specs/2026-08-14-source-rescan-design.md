# Periodic Source Rescan Design

## Goal

Sources that have finished a full collection pass (`status: "completed"`) are
never scanned again today. Once the backlog they produced is exhausted, the
follow batch engine has nothing left to work on and falls through to the next
lifecycle deadline (follow-back review), which can be a day or more away —
even though the same source will keep gaining new followers over time that
the engine could pick up automatically.

This design adds an automatic, interval-based rescan of already-completed
sources so new followers keep feeding the existing 50-per-batch /
5–10s-per-action / 5–7min-per-cycle automation, without any manual
intervention.

## Decision

Introduce a new global setting, `sourceRescanHours` (default `6`,
user-configurable in Settings), and broaden source *scan eligibility* to also
include `"completed"` sources whose `lastCollectedAt` is older than
`sourceRescanHours`. No new source status is introduced — `"completed"`
remains the terminal state after every collection pass, including rescans;
only the *eligibility check* changes.

## Data flow

1. `nextAutomaticSource(sources, attempted, now, rescanHours)` — extends its
   existing `status === "pending" || status === "error"` filter with:
   `status === "completed" && (now - lastCollectedAt) >= rescanHours * 3_600_000`.
   Ordering is unchanged: the oldest `lastCollectedAt`/`updatedAt` wins the
   tie-break (`sourceRotationTimestamp`), so overdue rescans and brand-new
   pending sources compete fairly for the same rotation slot.
2. `hasSourceScanWork(state, now)` — same broadened condition, so
   `refreshGlobalDeadlines` correctly decides a scan is due.
3. `nextSourceRescanDate(state, now)` (new, mirrors the existing
   `nextFollowBackReviewDate` helper) — for every `"completed"` source not
   yet due, computes `lastCollectedAt + sourceRescanHours`, and returns the
   earliest one. `nextGlobalWorkDate` adds this to its `futureDates`
   candidates, so when nothing else is due the engine schedules its alarm for
   exactly that timestamp instead of jumping to a distant lifecycle date.
4. Collection itself (`collectSource`, `sourceCollectionLimit`,
   `mergeCollectedCandidates`) is unchanged. A rescan requests the source's
   configured `limit` (default `perSourceLimit`, 200) again, the same as an
   initial scan. `mergeCollectedCandidates` already dedupes by
   `normalizedHandle`: known handles (followed, skipped, pending, failed)
   only get their `sourceIds`/`updatedAt` touched; genuinely new handles
   become fresh `pending_follow` candidates, up to `backlogMaximum`. After
   collection, `replaceSource` sets `status: "completed"` again with a fresh
   `lastCollectedAt`, restarting the interval clock.

## Settings and UI

- `followup-model.js`: add `sourceRescanHours: 6` to
  `DEFAULT_FOLLOWUP_SETTINGS`, add `"sourceRescanHours"` to
  `POSITIVE_NUMBER_SETTINGS` for validation (must be a positive number, same
  rule as `unfollowDelayDays`).
- `sidepanel.js` / `sidepanel.html`: add `sourceRescanHours:
  "source-rescan-hours-input"` to `SETTING_FIELDS`, following the existing
  pattern used for every other delay setting (label, input, save wiring).

## Explicitly out of scope (YAGNI)

- No per-source rescan interval override — one global setting, like
  `unfollowDelayDays`.
- No growing quota per rescan (e.g. fetching progressively deeper into the
  follower list). Every rescan reuses the same per-source `limit`.
- No change to automation gating: rescans follow exactly the same
  Autopilot on/off, `backlogMaximum`, and `refillThreshold` rules that already
  govern regular source scans.

## Testing

- `followup-model.test.mjs`: `sourceRescanHours` default value and
  validation (rejects zero/negative).
- `followup-engine.test.mjs`:
  - a `"completed"` source past its rescan interval is selected by
    `nextAutomaticSource` / makes `hasSourceScanWork` true;
  - a `"completed"` source still within its interval is skipped;
  - `nextGlobalWorkDate` returns the correct future timestamp when the only
    pending work is a not-yet-due rescan;
  - a rescan that returns only already-known handles leaves candidate
    statuses untouched and does not duplicate candidates;
  - a rescan that returns new handles adds them as `pending_follow` and they
    flow into the next batch selection.

## Verification

- `npm test` (Node test runner) covering the cases above.
- Manual check in the unpacked extension: mark a source `"completed"` with an
  old `lastCollectedAt` (via test harness or by waiting past a short test
  interval), confirm Autopilot's "Up Next" card shows the rescan countdown
  and that new followers surface as new `pending_follow` candidates after it
  fires.

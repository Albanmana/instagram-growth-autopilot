# Live Run Indicator Design

## Goal

Make manual `Scrape + Follow` activity visibly live in the side panel and show
the number of followers successfully followed during the current manual run.

## Recommended approach

Use ephemeral side-panel state rather than persisting a second run record. The
existing engine remains the source of truth for actions and history; the panel
only represents the currently pending manual request and derives its confirmed
follow count from the successful `follow` outcomes observed while that request
is active.

This avoids changing the follow-up data schema and resets naturally whenever
the panel reloads or a new manual run begins.

## UI behavior

- Clicking `Scrape + Follow` immediately shows a compact live-status row in the
  Manual Collection card.
- The row has a CSS-only animated pulse, an accessible live status message, and
  a counter such as `0 followed this run`.
- While the runtime request is pending, the message reads `Opening Followers
  modal and processing visible rows…`.
- The counter displays only terminal outcomes with `action: follow` and
  `status: succeeded` received for this manual run. Skipped and failed rows do
  not increase it.
- On completion, the pulse stops and the row reports either `Run complete` or
  `Run stopped with an error`; the final counter remains visible until the next
  manual run or panel reload.

## Data flow

`sidepanel.js` captures the history baseline immediately before it sends
`RUN_MANUAL_SOURCE`. When the response returns, it compares the response's
persisted history to that baseline and counts only newly added successful
follow entries. No Instagram DOM state, credentials, or timers are stored.

The existing polling remains responsible for refreshing persisted data but must
not reset an in-progress indicator. A later stale poll must likewise be unable
to overwrite the local live-run status.

## Error handling and accessibility

The status row uses `role="status"` with polite announcements. The pulse is
disabled through `prefers-reduced-motion`. A failed runtime response reports
the error, stops the animation, preserves the zero or partial count, and leaves
the current persisted panel render intact.

## Tests

Side-panel tests cover: immediate visible animated/pending state, incrementing
only for a newly persisted successful follow, excluding skipped/failed actions,
and terminal completion/error state. Existing full-suite and live Instagram
tests remain unchanged.

# Modal Direct Follow Design

## Goal

When a supplied Instagram source is scraped, follow each visible follower directly from its Followers modal instead of first building a follow backlog and opening each follower profile in a separate tab.

The behavior applies identically to manual **Scrape + Follow** and **Start Auto** source collection.

## User flow

1. The engine opens the supplied source profile and opens its Followers modal.
2. It reads a visible follower row, identifies its canonical profile link and its row-local relationship button.
3. If the row shows the localized Follow state (`Suivre` or `Follow`), it clicks that exact row button.
4. It requires the same row to visibly change to the localized Following state (`Suivi(e)` or `Following`) before recording success.
5. It waits the configured randomized action delay (default 10–20 seconds) before the next eligible row.
6. Rows already followed, missing an unambiguous row button, or without a verified post-click state change are skipped or failed locally. They never count as a successful follow.
7. The modal is scrolled and processed until the requested limit, an Instagram preview/owner-only limitation, or a stable end of visible results.

## Architecture

`instagram-followers.js` becomes the modal-scoped collector/action adapter. It owns only DOM observation, scrolling, and one verified row-local follow click. It returns immutable operation outcomes and does not write Chrome storage.

`followup-engine.js` remains the sole persistent scheduler. While collecting a source, it consumes one modal row at a time, persists terminal outcomes/history, and honors the existing action delay, pause, stop, lease, and restart semantics. It does not create an intermediate `pending_follow` backlog for rows processed directly in the modal.

The existing delayed-unfollow lifecycle is preserved: a verified direct follow becomes `followed` with `followedAt` and `unfollowDueAt`; only verified success is eligible for the later unfollow flow.

## Boundaries and failures

- The action is bound to the canonical profile link and the nearest row-local visible relationship button; never a modal-wide button.
- Only `Suivre`/`Follow` is clickable. `Suivi(e)`/`Following` is an already-followed skip.
- The post-click state must be observed on the same row before success is persisted.
- If a session redirect, modal replacement, ambiguous row, unavailable control, or DOM error occurs, the engine preserves the source state and records a retryable local failure.
- The owner-only/preview warning is persisted as before; its currently visible rows can be processed, but it is never treated as the full requested limit.
- No real Instagram action is performed during implementation or automated tests.

## Testing

- Unit tests cover French and English labels, row scoping, already-followed rows, ambiguous/missing buttons, exact post-click transitions, delay scheduling, pause/stop, and retry/restart behavior.
- Integration tests prove Manual and Auto share the same direct-modal action path and no profile-per-candidate tab gateway is invoked for follow actions.
- Full `npm test` and `git diff --check` are required before handoff.

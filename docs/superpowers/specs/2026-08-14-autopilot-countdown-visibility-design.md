# Autopilot Countdown Visibility Design

## Goal

Make the next persisted Instagram action legible at a glance: what will run, for whom or from which source, and the remaining time before it can run.

## Decision

The existing **Next global work** card becomes a live operational timeline. It will be updated once a second while the panel is visible, but its truth comes only from the persisted follow-up state. A timer never schedules work and never invents an action.

## User-facing states

1. **Scheduled action**: action type, exact target or source, countdown, absolute local time, and a three-row preview.
2. **Follow/unfollow batch**: selected candidate list in engine order; first item is the next action, next three are previewed. The next action countdown uses the durable `run.nextWorkAt` safety deadline when available.
3. **Scheduled source or relationship review**: the source handle or follow-back-review label, countdown, and absolute local time.
4. **In progress**: source scan, review, or Instagram profile action is explicitly shown as underway, with no fabricated remaining duration.
5. **Paused, stopped, recovery, or no work**: explanatory static state, with no countdown.

## Data contract

The side panel derives a display model from the existing persisted state only:

- `run.activeBatch.kind` and `candidateIds` select follow/unfollow work.
- Candidate records supply handles and queued order.
- `run.nextWorkAt` is the primary action deadline.
- `run.nextSourceScanAt` plus `sourceScanSourceId` identifies the next source scan.
- `run.nextRelationshipReviewAt` identifies the next follow-back review.
- The existing phase fields determine whether a real action is in progress.

When there is a pending follow/unfollow but no valid future deadline, the UI names the work but says it is **ready in the action lane** rather than displaying a false zero-second timer.

## Visual layout

The card contains:

```
NEXT ACTION                         SCHEDULED
Follow @alice
in 00:18
Today at 14:32:18 · from @noevarner.ai

Then
2 · Follow @bob                    in ~00:35
3 · Follow @carla                  in ~00:52
4 · Follow @david                  in ~01:09
```

The countdown changes at one-second granularity. `prefers-reduced-motion` disables decorative pulse animation but not text updates. Live regions use polite announcements and avoid announcing every tick; only action identity/status changes are live-announced.

## Scope and safety

- No new background messages, storage fields, alarm behavior, or Instagram DOM actions.
- The timer is created only while `document.visibilityState` is visible and removed on `pagehide` / visibility hidden.
- The existing two-second persisted-state poll remains the source of state changes. The one-second visual tick re-renders from the last trusted state.
- Existing lifecycle controls and recovery-required behavior remain unchanged.

## Verification

- Unit tests cover precise action/source identification, zero-to-ready transition, three-item preview order, no false countdown for in-progress/recovery, and visible-only timer lifecycle.
- The full test suite, syntax check, diff check, and real extension UI render are run after implementation.

# Four-hour balanced cadence implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a safe four-hour follow-up cycle with 50 unfollows before 50 follows, a 48-hour non-follow-back rule, a 1,000 active-follow cap, and a truthful 48-hour operational timeline.

**Architecture:** Extend the persisted follow-up settings/state with a four-hour cycle deadline and active-follow cap. The background engine performs the relationship review and serial action batches; the side panel derives certain schedule facts and labelled projections from that durable state without scheduling work itself.

**Tech Stack:** Manifest V3 JavaScript modules, Chrome alarms, revisioned local/relational follow-up store, Node test runner, existing accelerated extension E2E harness.

## Global Constraints

- Preserve one serial global Instagram action lane and all recovery/lease fences.
- A completed relationship review is required before a non-follow-back becomes eligible at 48 hours.
- A observed follow-back is eligible for the same cycle; incomplete review data is non-authoritative.
- Execute at most 50 unfollows then at most 50 follows in each four-hour cycle.
- Skip follows at or above 1,000 active follows while still draining eligible unfollows.
- The timeline must distinguish persisted `Programmé` entries from calculated `Prévision` entries.
- E2E verification must use the accelerated local harness and must not send live Instagram actions.

---

### Task 1: Persist cadence, cap, and lifecycle rules

**Files:**
- Modify: `extension/followup-model.js`
- Modify: `extension/followup-store.js`
- Test: `test/followup-model.test.mjs`
- Test: `test/followup-store.test.mjs`

**Interfaces:**
- Produces validated `cycleIntervalHours: 4`, `activeFollowCap: 1000`, `unfollowDelayDays: 2`, and migration-safe persisted settings.
- Produces an `activeFollowCount(state)` helper covering durable active and in-flight follow states.

- [ ] Write failing model tests proving defaults, positive validation, and active-stock counting.
- [ ] Run `node --test test/followup-model.test.mjs test/followup-store.test.mjs` and confirm the new assertions fail.
- [ ] Add the validated fields and migration normalization without overwriting explicit prior operator settings.
- [ ] Run the targeted model/store tests and confirm they pass.

### Task 2: Execute the four-hour balanced cycle

**Files:**
- Modify: `extension/followup-engine.js`
- Modify: `extension/followup-model.js`
- Test: `test/followup-engine.test.mjs`

**Interfaces:**
- Consumes a persisted cycle deadline and completed relationship review result.
- Produces, in order, a maximum 50-unfollow batch then a maximum 50-follow batch; persists the following cycle deadline.

- [ ] Write failing engine tests for: review-before-selection; confirmed follow-back unfollow in the same cycle; absent follow-back only after 48 hours and a completed review; 50/50 ordering; and cap blocking follows while due unfollows run.
- [ ] Run `node --test test/followup-engine.test.mjs` and confirm each regression fails for missing cycle/cap behavior.
- [ ] Implement the minimum durable cycle coordinator and state transitions, retaining all action retry and recovery paths.
- [ ] Run the engine test file and confirm it passes.

### Task 3: Render the operational timeline

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.css`
- Modify: `extension/sidepanel.js`
- Test: `test/sidepanel.test.mjs`

**Interfaces:**
- Consumes persisted `run` deadlines, candidate lifecycle dates, cycle outcome/history, settings, sources, and active stock.
- Produces chronological `Programmé` entries and separate `Prévision` entries for the following 48 hours.

- [ ] Write failing panel tests for certain versus projected labels, persisted countdown/local timestamp, 48-hour cohort projection, capacity/cap display, and paused/recovery truthfulness.
- [ ] Run `node --test test/sidepanel.test.mjs` and confirm the assertions fail.
- [ ] Implement a pure timeline display model and render it without adding scheduling behavior to the panel.
- [ ] Run the panel test file and confirm it passes.

### Task 4: Accelerated end-to-end validation

**Files:**
- Modify: `extension/live-accelerated-test.js` only if the current accelerated harness cannot advance four-hour cycles and the 48-hour threshold deterministically.
- Modify: `test/live-accelerated-test.test.mjs`
- Modify: `test/e2e/run-extension-e2e.mjs` only for user-visible timeline assertions.

**Interfaces:**
- Uses the existing virtual lifecycle clock; safety/action spacing remains wall-clock.
- Produces a no-Instagram-action proof for an accelerated multi-cycle review, 48-hour eligibility transition, cap behavior, and timeline render.

- [ ] Write the failing accelerated lifecycle/E2E test using virtual time through at least 48 hours.
- [ ] Run the focused accelerated test and confirm it fails before the implementation is wired.
- [ ] Adapt only the test harness plumbing needed to drive persisted four-hour cycles; do not bypass engine state transitions.
- [ ] Run focused accelerated tests, `npm test`, `npm run test:e2e`, and `npm run test:e2e:service` and confirm zero failures and no Instagram activity.
- [ ] Reload the unpacked extension, inspect the side panel timeline without starting automation, and record Chrome's refresh confirmation.

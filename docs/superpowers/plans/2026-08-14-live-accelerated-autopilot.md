# Live Accelerated Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a ten-candidate real-Instagram autopilot test with accelerated calendar lifecycle checks and unchanged real action pacing.

**Architecture:** Add an isolated persisted development test-session clock that maps virtual calendar timestamps to Chrome alarms. Transport scheduler intent from the engine so action-safety waits remain wall-clock while lifecycle alarms are accelerated. A narrow panel control starts the bounded session only for a local paired unpacked extension.

**Tech Stack:** Manifest V3 service worker, Chrome storage/alarms, local Supabase service, vanilla JavaScript, Node test runner, Chrome Computer Use.

## Global Constraints

- Use the normal signed-in Instagram session and DOM adapters; no mock Instagram page or external API.
- Maximum source limit is exactly 10 for this test mode.
- Calendar scale is 7 virtual days per real minute; configured action and batch delays are never reduced.
- Test mode is local/development only, explicit, persisted, finite, and safe after restart/recovery.

---

### Task 1: Persist and map the bounded live-test clock

**Files:**

- Create: `extension/live-accelerated-test.js`
- Test: `test/live-accelerated-test.test.mjs`

**Interfaces:** `createLiveAcceleratedTest({ storage, now })` exposes `load()`, `start({ sourceId })`, `stop()`, `now()`, and `toAlarmTime(virtualDate, { safety })`.

- [ ] **Step 1: Write the failing test.** Assert that seven virtual days maps to one real minute while a ten-second safety delay maps to ten real seconds.
- [ ] **Step 2: Run `node --test test/live-accelerated-test.test.mjs` and verify it fails because the module is absent.**
- [ ] **Step 3: Add the minimum session module.** Export `LIVE_ACCELERATED_TEST_KEY`, `LIVE_TEST_SOURCE_LIMIT = 10`, and `LIVE_TEST_SCALE = 10080`; persist origin pair, source ID, expiration, and active status; reject invalid sources and expire safely.
- [ ] **Step 4: Run `node --test test/live-accelerated-test.test.mjs` and verify conversion, expiration, and restart-loading tests pass.**
- [ ] **Step 5: Commit `extension/live-accelerated-test.js` and `test/live-accelerated-test.test.mjs` as `feat: add bounded live accelerated clock`.**

### Task 2: Preserve real action spacing through scheduler intent

**Files:**

- Modify: `extension/followup-engine.js`
- Modify: `extension/background.js`
- Test: `test/followup-engine.test.mjs`
- Test: `test/background-followup.test.mjs`

**Interfaces:** Engine calls `schedule(at, INSTAGRAM_FOLLOWUP_NEXT_ALARM, { safety })`; background maps alarms through `liveTest.toAlarmTime(at, { safety })` only for an active session.

- [ ] **Step 1: Write failing tests.** Assert `scheduleAfter` forwards `{ safety: true }` and remote runtime maps only a lifecycle alarm through the accelerated clock.
- [ ] **Step 2: Run focused engine and background tests; verify the two new expectations fail.**
- [ ] **Step 3: Add scheduler intent forwarding.** The background maps non-safety work through the active test session and uses the original `Date` for safety work.
- [ ] **Step 4: Run focused engine/background tests; verify normal-mode alarms and action delay behavior remain unchanged.**
- [ ] **Step 5: Commit the engine/background and test changes as `feat: accelerate calendar alarms for live tests`.**

### Task 3: Add explicit local-development start path

**Files:**

- Modify: `extension/background.js`
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js`
- Modify: `extension/sidepanel.css`
- Test: `test/background-followup.test.mjs`
- Test: `test/sidepanel.test.mjs`

**Interfaces:** `START_LIVE_ACCELERATED_TEST` accepts `{ sourceId }`, caps only that existing source at 10, persists a test session, then calls normal `engine.startAuto()`.

- [ ] **Step 1: Write failing runtime and panel tests.** Assert the intent refuses an unknown source, caps an existing one at ten, starts the normal engine, and renders current live-test status.
- [ ] **Step 2: Run focused background/panel tests and verify the expectations fail.**
- [ ] **Step 3: Implement the narrow start path.** Require a paired local service; use existing activity and stale-read safeguards; show active, expired, or stopped state without adding a normal-production control.
- [ ] **Step 4: Run focused background/panel tests and verify all pass.**
- [ ] **Step 5: Commit the runtime, panel, and test changes as `feat: add local accelerated live test control`.**

### Task 4: Verify local and live behavior

**Files:**

- Test: `test/live-accelerated-test.test.mjs`
- Test: `test/e2e/run-live-smoke.mjs`

- [ ] **Step 1: Run focused test mode, engine, background, and panel suites, then `npm test`; all must pass.**
- [ ] **Step 2: Reload the unpacked extension via the `reload-unpacked-chrome-extension` skill and confirm Chrome reports `Extension actualisée`.**
- [ ] **Step 3: Use Computer Use to start the session with an existing source. Verify real Instagram collection/action activity plus durable local Supabase candidates, action history, and run state. Do not claim a follow-back confirmation or unfollow unless Instagram’s actual followers list and persisted history show it.**
- [ ] **Step 4: Commit design and plan evidence as `docs: document live accelerated autopilot test`.**

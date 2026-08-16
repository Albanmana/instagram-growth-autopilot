# Autopilot Scheduler and Source Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure due unfollows cannot be starved by a failed source collection and terminally classify unavailable Instagram profiles.

**Architecture:** Keep source-state classification at the Instagram collector boundary; the engine maps it to a durable source status and selects the action lane before a deferred collection. The side panel derives readiness exclusively from a persisted executable deadline.

**Tech Stack:** Manifest V3 Chrome extension, JavaScript ES modules, Node test runner, Playwright.

## Global Constraints

- Preserve existing local candidates and activity history for unavailable sources.
- Do not run a real Instagram follow or unfollow during automated verification.
- Keep transient source failures retryable using the current cadence.

---

### Task 1: Scheduler priority regression

**Files:**
- Modify: `test/followup-engine.test.mjs`
- Modify: `extension/followup-engine.js`

**Interfaces:**
- Consumes: `runDueWork()` and `selectNextWork(state, now)`.
- Produces: a scheduled due unfollow before a deferred `cycle.stage === "collect"` retry.

- [ ] Write a failing harness test with a due unfollow, a balanced collection retry in the future, and a source.
- [ ] Run `node --test test/followup-engine.test.mjs` and confirm the unfollow does not run before the fix.
- [ ] Make `runDueWork()` select and process due action work before deferring a non-due balanced collection.
- [ ] Re-run `node --test test/followup-engine.test.mjs` and confirm the regression passes.

### Task 2: Terminal unavailable source classification

**Files:**
- Modify: `test/instagram-followers.test.mjs`
- Modify: `test/followup-engine.test.mjs`
- Modify: `extension/instagram-followers.js`
- Modify: `extension/followup-engine.js`

**Interfaces:**
- Produces: errors with `code === "SOURCE_UNAVAILABLE"` from the collector and durable source status `unavailable` from the engine.

- [ ] Write failing DOM and engine regressions for an unavailable profile page.
- [ ] Run the targeted test files and confirm they fail for the missing classification.
- [ ] Detect Instagram's unavailable page before followers-trigger polling, preserve the structured code through the collector, and classify the source without scheduling a retry.
- [ ] Re-run targeted tests and confirm the source is excluded from automatic scans while the cycle continues.

### Task 3: Honest panel state and end-to-end verification

**Files:**
- Modify: `test/sidepanel.test.mjs`
- Modify: `extension/sidepanel.js`
- Verify: `test/e2e/run-extension-e2e.mjs`

**Interfaces:**
- Consumes: persisted `run.nextWorkAt`, source statuses, and scheduler health.
- Produces: scheduled presentation for deferred action work and an explanatory unavailable source row.

- [ ] Write a failing side-panel regression for a due unfollow held by a future source retry.
- [ ] Run `node --test test/sidepanel.test.mjs` and confirm it fails.
- [ ] Render the stored deadline rather than a false ready state, and expose unavailable source status.
- [ ] Run `npm test`, reload the unpacked Chrome extension, and run `npm run test:e2e`.

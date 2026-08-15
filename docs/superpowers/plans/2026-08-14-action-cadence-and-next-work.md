# Action Cadence and Next Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real automated cadence explicit and let the dashboard show the next follow action with its scheduled time.

**Architecture:** Persist the user's action timing settings through the existing settings store, and keep the engine's single global lane unchanged: 50 actions per cycle, a short action-to-action interval, then an inter-cycle pause. The side panel derives the display from the persisted `run.nextWorkAt` and, when work is immediately due, states that it will start now rather than pretending that no time is known.

**Tech Stack:** Manifest V3 JavaScript modules, Chrome alarms, local/relational follow-up store, Node test runner.

## Global Constraints

- Keep follows and unfollows in one global serial lane; never schedule them concurrently.
- Use 5–10 seconds between actions, 50 accounts per cycle, and 5–7 minutes between cycles.
- Preserve explicit operator-selected settings and do not overwrite them merely by rendering the panel.
- Do not perform Instagram actions during automated verification.
- Reload the unpacked Chrome extension and require Chrome's `Extension actualisée` confirmation after source changes.

---

### Task 1: Persisted default cadence

**Files:**
- Modify: `extension/followup-model.js:1-12`
- Test: `test/followup-model.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_FOLLOWUP_SETTINGS`.
- Produces: default `actionDelayMinSeconds: 5`, `actionDelayMaxSeconds: 10`, `batchSize: 50`, `batchDelayMinMinutes: 5`, `batchDelayMaxMinutes: 7`.

- [x] **Step 1: Write the failing test**

```js
test("refuses early wakes for action, inter-batch and blocked retry deadlines", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice"), pendingFollow("bob")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice", "instagram:bob"] },
  });
  await harness.engine.runDueWork();
  assert.equal(harness.rawState().run.nextWorkAt, "2026-08-13T01:00:05.000Z");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/followup-model.test.mjs`

Expected: the default action delay is still 10–20 seconds.

- [x] **Step 3: Write minimal implementation**

```js
export const DEFAULT_FOLLOWUP_SETTINGS = Object.freeze({
  batchSize: 50,
  actionDelayMinSeconds: 5,
  actionDelayMaxSeconds: 10,
  batchDelayMinMinutes: 5,
  batchDelayMaxMinutes: 7,
});
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test test/followup-model.test.mjs`

Expected: PASS.

### Task 2: Truthful next-action panel state

**Files:**
- Modify: `extension/sidepanel.js:430-500`
- Test: `test/sidepanel.test.mjs`

**Interfaces:**
- Consumes: persisted candidates, `run.nextWorkAt`, and current clock.
- Produces: a scheduled countdown when an action deadline exists and `Starting in the global action lane now.` for immediate due work.

- [x] **Step 1: Write failing panel tests**

```js
test("a ready follow cycle says it starts now rather than hiding its execution state", async () => {
  await render({ automationEnabled: true, candidates: [pendingFollow("alice")] });
  assert.match(nextWork.textContent, /Starting in the global action lane now/);
});

test("a scheduled first follow displays its exact next action and countdown", async () => {
  await render({ run: { nextWorkAt: futureIso }, activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] } });
  assert.match(nextWork.textContent, /Follow @alice/);
  assert.match(nextWork.textContent, /in 0:0[0-9]/);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/sidepanel.test.mjs`

Expected: ready work renders `Waiting for the global action lane.`.

- [x] **Step 3: Write minimal implementation**

```js
const READY_DETAIL = "Starting in the global action lane now.";
// Use READY_DETAIL for due follows, unfollows, reviews, and scans. Retain valid
// `nextWorkAt` as the deadline for an active batch so the existing countdown renders.
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test test/sidepanel.test.mjs`

Expected: PASS.

### Task 3: End-to-end verification and reload

**Files:**
- Test: `test/e2e/run-extension-e2e.mjs`

- [x] **Step 1: Verify targeted suites**

Run: `node --test test/followup-model.test.mjs test/sidepanel.test.mjs test/followup-engine.test.mjs`

Expected: all selected tests pass.

- [x] **Step 2: Verify repository suite and extension contract**

Run: `npm test && npm run test:e2e && node --check extension/followup-model.js && node --check extension/sidepanel.js && git diff --check`

Expected: zero failures; the E2E contract reports no Instagram activity.

- [x] **Step 3: Reload and inspect the actual Chrome extension**

Use the `reload-unpacked-chrome-extension` skill to reload only the `Instagram Follow-Up` card, require `Extension actualisée`, reopen `chrome-extension://mldhdiailafielbfdmmejlmadjoiapoo/sidepanel.html`, and inspect the new cadence settings and next-work panel without starting automation.

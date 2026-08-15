# Autopilot Countdown Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the precise next persisted follow-up action, its live countdown, target/source, and the next three queued accounts in the Instagram Growth Autopilot sidebar.

**Architecture:** `extension/sidepanel.js` derives a pure display model from the persisted follow-up state and renders it into an expanded Next global work card. A visible-only one-second interval re-renders that model from the last trusted state; the existing two-second runtime poll remains authoritative. The background engine and Instagram action adapters are not changed.

**Tech Stack:** Manifest V3 side panel, vanilla ES modules, DOM APIs, Node built-in test runner, existing side-panel fake DOM harness.

## Global Constraints

- Do not add remote calls, credentials, storage fields, alarms, or Instagram actions.
- Derive all countdowns from persisted ISO dates (`nextWorkAt`, source scan, and follow-back review deadlines).
- Never show a countdown for active/recovery work or synthesize an unavailable action deadline.
- Update once per second only while the document is visible; clear the interval on hidden/pagehide.
- Retain existing accessible tabs, lifecycle controls, and recovery behavior.

---

### Task 1: Define and test the timeline display model

**Files:**
- Modify: `test/sidepanel.test.mjs`
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: persisted `state.run`, `state.candidates`, and `state.sources`.
- Produces: `nextWorkModel(state, now)` returning `{ state, title, detail, deadline, preview }` where `state` is `scheduled`, `ready`, `active`, or `static` and `preview` contains at most three items.

- [x] **Step 1: Write failing tests**

```js
test("the next-work card identifies the persisted next follow and counts down", async () => {
  const state = dashboardState({
    automationEnabled: true,
    phase: "waiting",
    candidates: [candidate("alice"), candidate("bob")],
    run: { activeBatch: { kind: "follow", candidateIds: ["instagram:alice", "instagram:bob"] }, nextWorkAt: FUTURE },
  });
  // Assert title names @alice, countdown starts at 00:10, and @bob appears in preview.
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/sidepanel.test.mjs`

Expected: FAIL because the card only renders a static `next-work` string and no countdown/preview elements exist.

- [x] **Step 3: Implement the pure model and rendering helpers**

```js
function nextWorkModel(state, now = new Date()) {
  // Return active/static states first, then current batch, then source/review schedule.
}

function renderNextWork(state, now = new Date()) {
  const model = nextWorkModel(state, now);
  // Render title, detail, countdown, absolute time, and up to three preview rows.
}
```

- [x] **Step 4: Run the focused test to verify it passes**

Run: `node --test test/sidepanel.test.mjs`

Expected: PASS, including existing side-panel behavior.

- [ ] **Step 5: Commit** (intentionally not performed: the shared worktree already contains unrelated uncommitted implementation work)

```bash
git add extension/sidepanel.js extension/sidepanel.html extension/sidepanel.css test/sidepanel.test.mjs
git commit -m "feat: show upcoming autopilot actions"
```

### Task 2: Add visible-only live countdown behavior

**Files:**
- Modify: `test/sidepanel.test.mjs`
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: `nextWorkModel(state, now)` and `followupState`.
- Produces: `startCountdown()` / `stopCountdown()` timer lifecycle functions.

- [x] **Step 1: Write failing timer tests**

```js
test("the countdown decrements once per second only while the panel is visible", async () => {
  // Capture test intervals, advance Date.now, invoke the one-second callback.
  // Assert 00:10 becomes 00:09 and the interval is cleared when hidden.
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/sidepanel.test.mjs`

Expected: FAIL because no visual countdown interval exists.

- [x] **Step 3: Implement minimal timer lifecycle**

```js
function renderCountdownTick() {
  if (followupState) renderNextWork(followupState, new Date());
}

function startCountdown() { /* create one 1,000 ms interval only when visible */ }
function stopCountdown() { /* clear and null the interval */ }
```

- [x] **Step 4: Run focused tests to verify they pass**

Run: `node --test test/sidepanel.test.mjs`

Expected: PASS with no leaked timer handles in pagehide/visibility behavior.

- [ ] **Step 5: Commit** (intentionally not performed: the shared worktree already contains unrelated uncommitted implementation work)

```bash
git add extension/sidepanel.js test/sidepanel.test.mjs
git commit -m "feat: update autopilot countdown while visible"
```

### Task 3: Verify the delivered extension

**Files:**
- Modify: `docs/superpowers/specs/2026-08-14-autopilot-countdown-visibility-design.md`
- Modify: `docs/superpowers/plans/2026-08-14-autopilot-countdown-visibility.md`

- [x] **Step 1: Run complete verification**

Run: `npm test && node --check extension/sidepanel.js && git diff --check`

Expected: all tests pass, syntax succeeds, and no whitespace errors.

- [x] **Step 2: Run the extension UI test**

Run: `npm run test:e2e`

Expected: the MV3 service worker and side panel load; the countdown card renders from fixture state without Instagram navigation.

- [x] **Step 3: Reload the unpacked extension and inspect the panel**

Use the `reload-unpacked-chrome-extension` skill, then confirm the card in the existing Chrome profile renders the current persisted state.

- [ ] **Step 4: Commit final documentation** (intentionally not performed: the shared worktree already contains unrelated uncommitted implementation work)

```bash
git add docs/superpowers/specs/2026-08-14-autopilot-countdown-visibility-design.md docs/superpowers/plans/2026-08-14-autopilot-countdown-visibility.md
git commit -m "docs: document autopilot countdown visibility"
```

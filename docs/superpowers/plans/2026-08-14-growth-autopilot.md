# Growth Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the local Instagram Follow-Up extension into a simple, globally paced autopilot that scans finite sources, records verified direct follows, verifies follow-backs from the account's followers list, and schedules the appropriate later unfollow.

**Architecture:** Keep `followup-engine.js` as the only durable scheduler and action lane. Add a relationship-review collector that scans the logged-in account's Followers list and updates only tracked candidates; model selection returns one next unit of work so source collection, follow-back review, follow, and unfollow never run concurrently. The side panel becomes a phase-driven Autopilot dashboard; settings expose only product controls and preserve advanced values locally.

**Tech Stack:** Manifest V3 service worker, Chrome storage/alarm APIs, DOM-only Instagram adapters, vanilla HTML/CSS/JS, Node test runner, Playwright Chromium extension harness.

## Global Constraints

- No API key, remote queue, tracking pixel, CRM, or network fetch is introduced.
- All durable state stays in `chrome.storage.local` and exported state remains credential-free.
- A single global action lane serializes source scans, relationship reviews, follows, and unfollows.
- A verified direct follow is never counted until its row-local Instagram control visibly transitions.
- A relationship review is a scan of the logged-in account's Followers list, matched against tracked candidates; it never opens each candidate profile.
- A non-follow-back is eligible for unfollow two days after the follow; a confirmed follow-back is eligible seven days after confirmation.
- The implementation uses conservative user-configured pacing and does not claim to bypass platform safeguards.

---

### Task 1: Extend the durable lifecycle model

**Files:**
- Modify: `extension/followup-model.js`
- Test: `test/followup-model.test.mjs`

**Interfaces:**
- Produces `scheduleFollowBackReview(state, now)`, `applyFollowBackReview(state, handles, now)`, and `nextDueLifecycleAt(state, now)`.
- Candidate fields: `followBackStatus: "unknown" | "confirmed"`, `lastFollowBackCheckAt`, `followBackAt`, `followBackReviewDueAt`, and `unfollowDueAt`.

- [ ] **Step 1: Write failing model tests**

```js
test("confirmed follow-backs move the unfollow date to seven days after confirmation", () => {
  const state = withFollowedCandidate("alice", { unfollowDueAt: "2026-08-16T01:00:00.000Z" });
  const updated = applyFollowBackReview(state, ["alice"], new Date("2026-08-14T01:00:00.000Z"));
  assert.equal(updated.candidates[0].followBackStatus, "confirmed");
  assert.equal(updated.candidates[0].unfollowDueAt, "2026-08-21T01:00:00.000Z");
});
```

- [ ] **Step 2: Run the focused model test and verify RED**

Run: `node --test test/followup-model.test.mjs`

Expected: FAIL because the lifecycle function and fields are absent.

- [ ] **Step 3: Implement validated lifecycle fields and transitions**

```js
if (matchedHandles.has(candidate.normalizedHandle)) {
  candidate.followBackStatus = "confirmed";
  candidate.followBackAt ??= at;
  candidate.unfollowDueAt = addDays(candidate.followBackAt, settings.followBackUnfollowDelayDays);
} else if (candidate.status === "followed") {
  candidate.lastFollowBackCheckAt = at;
}
```

- [ ] **Step 4: Run focused model tests and verify GREEN**

Run: `node --test test/followup-model.test.mjs`

Expected: PASS, including canonical date validation, export filtering, and unfollow priority.

- [ ] **Step 5: Commit**

```bash
git add extension/followup-model.js test/followup-model.test.mjs
git commit -m "feat: model follow-back lifecycle"
```

### Task 2: Add DOM-only own-followers relationship review

**Files:**
- Modify: `extension/instagram-followers.js`
- Modify: `extension/background.js`
- Test: `test/instagram-followers.test.mjs`
- Test: `test/background-followup.test.mjs`

**Interfaces:**
- Produces `collectOwnFollowerHandles({ limit, signal }) -> { handles, warning }` on the Instagram adapter.
- Background injects it through the existing tab gateway and closes any temporary tab in `finally`.

- [ ] **Step 1: Write failing adapter tests**

```js
test("collectOwnFollowerHandles only returns canonical handles from the bound Followers dialog", async () => {
  const result = await adapter.collectOwnFollowerHandles({ limit: 30 });
  assert.deepEqual(result.handles, ["alice", "bob"]);
});
```

- [ ] **Step 2: Run the focused adapter suite and verify RED**

Run: `node --test test/instagram-followers.test.mjs test/background-followup.test.mjs`

Expected: FAIL because the own-followers method is not composed.

- [ ] **Step 3: Implement bounded own-account Followers collection**

```js
const reviewed = await followers.collectOwnFollowerHandles({
  profileUrl: ownerProfileUrl,
  limit: relationshipReviewLimit,
  signal,
});
return { handles: reviewed.handles.map((handle) => handle.toLowerCase()), warning: reviewed.warning ?? null };
```

The collector must bind both the loaded profile route and newly opened dialog, accept only exact one-segment Instagram profile links, deduplicate case-insensitively, and surface a warning rather than treating an incomplete list as negative evidence.

- [ ] **Step 4: Run focused adapter and background tests and verify GREEN**

Run: `node --test test/instagram-followers.test.mjs test/background-followup.test.mjs`

Expected: PASS, with no API calls and guaranteed temporary-tab cleanup.

- [ ] **Step 5: Commit**

```bash
git add extension/instagram-followers.js extension/background.js test/instagram-followers.test.mjs test/background-followup.test.mjs
git commit -m "feat: collect follow-back membership locally"
```

### Task 3: Schedule global cycles and relationship decisions

**Files:**
- Modify: `extension/followup-engine.js`
- Modify: `extension/followup-model.js`
- Test: `test/followup-engine.test.mjs`

**Interfaces:**
- Engine dependency: `collectOwnFollowerHandles({ limit, signal })`.
- Run state: `nextSourceScanAt`, `nextRelationshipReviewAt`, and `nextWorkAt` are canonical ISO strings.
- Engine methods: `scanNow(sourceId)` and existing `runDueWork()`.

- [ ] **Step 1: Write failing scheduler tests**

```js
test("the global lane reviews due follow-backs before scanning sources", async () => {
  const harness = createEngineHarness({ automationEnabled: true, candidates: [followed("alice")] });
  await harness.engine.runDueWork();
  assert.equal(harness.calls.collectOwnFollowerHandles.length, 1);
  assert.equal(harness.calls.collectFollowers.length, 0);
});
```

- [ ] **Step 2: Run the engine suite and verify RED**

Run: `node --test test/followup-engine.test.mjs`

Expected: FAIL because relationship review is not scheduled.

- [ ] **Step 3: Implement one global work selector**

```js
const next = selectNextWork(state, now);
// priority: active action -> due unfollow -> due final review -> queued follow -> due source scan -> idle
if (next.kind === "relationship_review") return reviewFollowBacks(state);
if (next.kind === "source_scan") return runSourceCycle(state);
return processActiveAction(state);
```

Persist each outcome before scheduling the next item. A partial/failed review must keep unknown candidates unknown and schedule a retry; it must never accelerate an unfollow. `scanNow` enters the same queue and does not bypass an active action or safety deadline.

- [ ] **Step 4: Run the engine suite and verify GREEN**

Run: `node --test test/followup-engine.test.mjs`

Expected: PASS for restart recovery, pause/stop, due-unfollow priority, global cadence, manual scan queueing, and J+2/J+7 calculations.

- [ ] **Step 5: Commit**

```bash
git add extension/followup-engine.js extension/followup-model.js test/followup-engine.test.mjs
git commit -m "feat: schedule global follow-back lifecycle"
```

### Task 4: Replace the crowded panel with the Autopilot dashboard

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.css`
- Modify: `extension/sidepanel.js`
- Test: `test/sidepanel.test.mjs`

**Interfaces:**
- Panel sends `START_AUTO`, `PAUSE_AUTO`, `RESUME_AUTO`, `STOP_AUTO`, `SCAN_NOW`, `ADD_SOURCE`, `REMOVE_SOURCE`, `SAVE_FOLLOWUP_SETTINGS`, export, and reset intents.
- Main metrics derive solely from persisted candidate/history state: followed this run, confirmed follow-backs, conversion, waiting, and due unfollows.

- [ ] **Step 1: Write failing panel behavior tests**

```js
test("Autopilot renders one phase-appropriate control and the next global work item", async () => {
  await withPanel({ state: runningState() }, async ({ document }) => {
    assert.equal(document.getElementById("pause-button").hidden, false);
    assert.match(document.getElementById("next-work").textContent, /follow-back review/i);
  });
});
```

- [ ] **Step 2: Run the focused panel suite and verify RED**

Run: `node --test test/sidepanel.test.mjs`

Expected: FAIL because the old multi-card panel does not expose the Autopilot contract.

- [ ] **Step 3: Implement the four-section panel**

```html
<nav aria-label="Follow-up sections">
  <button data-section="autopilot">Autopilot</button>
  <button data-section="sources">Sources</button>
  <button data-section="growth">Growth</button>
  <button data-section="settings">Settings</button>
</nav>
```

Autopilot is the default view. It shows one primary lifecycle control, a live in-progress indicator, run-local verified follow counter, next queued work, and concise weekly metrics. Sources owns add/remove/Scan now; Growth owns lifecycle metrics/history; Settings exposes global cadence, follow-back review cadence, J+2/J+7 retention rules and advanced timing under disclosure.

- [ ] **Step 4: Run focused panel tests and verify GREEN**

Run: `node --test test/sidepanel.test.mjs`

Expected: PASS for phase rendering, polling, stale-read handling, accessible sections, source actions, metrics, settings validation, export, and confirmed reset.

- [ ] **Step 5: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.css extension/sidepanel.js test/sidepanel.test.mjs
git commit -m "feat: redesign growth autopilot dashboard"
```

### Task 5: Verify real extension wiring with Playwright

**Files:**
- Modify: `test/e2e/run-extension-e2e.mjs`
- Modify: `test/e2e-live-contract.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `npm run test:e2e` loads the unpacked MV3 extension into Chromium, opens the panel document through its extension URL, and asserts runtime messaging and rendered controls.

- [ ] **Step 1: Write a failing browser contract**

```js
await panel.getByRole("button", { name: "Start Autopilot" }).click();
await expect(panel.getByText(/Next.*source scan/i)).toBeVisible();
```

- [ ] **Step 2: Run the end-to-end runner and verify RED**

Run: `npm run test:e2e`

Expected: FAIL until the actual panel DOM and service worker expose the new contract.

- [ ] **Step 3: Implement the browser harness assertions**

The runner must use an isolated temporary Chromium profile, load only the unpacked extension, wait for its service worker, open `chrome-extension://<id>/sidepanel.html`, invoke local runtime intents, and verify UI updates without navigating to, mocking, cloning, or performing actions on Instagram.

- [ ] **Step 4: Run full validation**

Run: `npm test && npm run test:e2e && node --check extension/background.js && node --check extension/followup-engine.js && node --check extension/sidepanel.js && git diff --check`

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/run-extension-e2e.mjs test/e2e-live-contract.test.mjs package.json
git commit -m "test: validate growth autopilot extension e2e"
```

## Self-Review

- Model tasks own canonical persistence and exports; adapters own DOM-only collection; the engine owns scheduling; the panel owns presentation; Playwright owns integration proof.
- All requirements have a task: global cadence (Task 3/4), source scan (Task 3), direct verified follows (preserved and surfaced Task 3/4), follow-back detection (Task 1/2/3), J+2/J+7 unfollow (Task 1/3/4), single action lane (Task 3), local-only data (global constraints), and E2E verification (Task 5).
- Placeholder scan completed: no TBD/TODO or undefined interfaces remain.

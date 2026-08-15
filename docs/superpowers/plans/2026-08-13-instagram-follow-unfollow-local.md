# Instagram Follow / Unfollow Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cold DM sender with a local-only Instagram follower collection, follow backlog, and delayed-unfollow extension.

**Architecture:** Keep a single persisted MV3 engine in the service worker. It owns the local state, alarms, source progression and serialized Instagram actions; DOM-specific modules only scrape followers or perform one verified Follow/Unfollow operation. The side panel is a dashboard over this state and sends intent-only runtime messages.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript ES modules, `chrome.storage.local`, `chrome.alarms`, `chrome.tabs`, `chrome.scripting`, Node built-in test runner.

## Global Constraints

- Remove all Cold DM API-key, API client, remote queue, claim, result-reporting, message-send, LinkedIn and CSV-download runtime paths.
- Keep all product data only in `chrome.storage.local`; do not add a server, account, sync storage or external API.
- The only eligible source list in the MVP is Instagram followers of a supplied profile URL or handle.
- Collection never uses a supplied profile's Following list. The runtime relationship gateway opens the candidate's direct canonical profile for both Follow and Unfollow; the Following-list row branch is a defensive helper covered only by non-live DOM/UI tests and is not wired into the engine or gateway.
- Defaults: 200 candidates per source; backlog maximum 500; refill when fewer than 100 pending follows remain; 50 actions per batch; 10–20 seconds between actions; 5–7 minutes between batches; 2 days before unfollow is due.
- A handle is globally deduplicated, retains every source that found it, and is never automatically followed twice.
- Actions are serialized. Finish the active batch, observe the global inter-batch pause, then prioritize due unfollows over the next source/follow batch.
- A successful action requires exact profile identity validation plus a visible post-click Instagram state change; otherwise persist `failed` or `skipped`, never a success.
- `Pause` retains engine state. `Stop` clears the scheduled engine alarm, leaves historical/local candidate data intact, and disables automation until `Start Auto` is pressed again.
- `Start Auto`, `Resume`, and `Scrape + Follow` can cause live Instagram collection and/or relationship actions. The operator must obtain authorization immediately before a live action as an external procedural requirement; the extension has no runtime authorization gate and must not claim one.
- Live UI evidence from the connected French Instagram session (2026-08-13): profile follower counts and own `suivi(e)s` counts open `div[role="dialog"]`; a Following-modal row contains its canonical profile link and a `Suivi(e)` button; clicking that button opens a confirmation with `Ne plus suivre` and `Annuler`.
- Live UI evidence from `noevarner.ai`: Instagram displayed `Seul(e) noevarner.ai peut voir tous les followers.` and only exposed a preview list. Treat this as a completed preview scrape with a persisted warning, not as a source error and not as proof that the requested limit was reached.

---

## File Structure

- `extension/followup-model.js` — pure normalization, immutable state transitions, candidate selection, settings validation and export shaping.
- `extension/followup-store.js` — versioned `chrome.storage.local` persistence and local reset/export reads.
- `extension/instagram-followers.js` — narrow wrapper around the existing verified follower-modal scraper; returns candidates without CSV/download side effects.
- `extension/instagram-follow-actions.js` — one-profile Follow/Unfollow browser operation with identity and final-state checks.
- `extension/followup-engine.js` — dependency-injected persisted state machine that chooses and performs one serialized unit of work.
- `extension/background.js` — composition root, Instagram session check, alarms and intent-only runtime message handlers.
- `extension/sidepanel.{html,js,css}` — local dashboard and settings; no connection view.
- `test/followup-model.test.mjs`, `test/followup-store.test.mjs`, `test/followup-engine.test.mjs`, `test/instagram-follow-actions.test.mjs` — deterministic unit/regression coverage.

### Task 1: Establish the local follow-up domain model

**Files:**
- Create: `extension/followup-model.js`
- Create: `test/followup-model.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces `DEFAULT_FOLLOWUP_SETTINGS`, `normalizeSourceInput(value)`, `normalizeCandidate(raw, sourceId, now)`, `mergeCandidates(existing, incoming)`, `getPendingFollowCount(state)`, `getDueUnfollowCandidates(state, now)`, `selectNextBatch(state, now)`, `applyActionOutcome(state, action, outcome, now)`, `buildLocalExport(state)`.
- `FollowupState` contains `{ version: 1, automationEnabled, settings, sources, candidates, run, history }`. Its JSON export contains exactly `{ version, settings, sources, candidates, history }`; it excludes `run`, `automationEnabled`, credentials, and any other fields.
- Candidate statuses are exactly `pending_follow`, `following`, `followed`, `pending_unfollow`, `unfollowing`, `unfollowed`, `skipped`, `failed`; `failed` includes a retryable `nextAction` of either `follow` or `unfollow`.

- [ ] **Step 1: Write failing domain-model tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FOLLOWUP_SETTINGS,
  mergeCandidates,
  normalizeSourceInput,
  selectNextBatch,
} from "../extension/followup-model.js";

test("normalizes a profile handle and canonical Instagram profile URL", () => {
  assert.equal(normalizeSourceInput(" @Alice.Example "), "https://www.instagram.com/Alice.Example/");
  assert.throws(() => normalizeSourceInput("https://instagram.com/p/abc/"), /profile/i);
});

test("deduplicates candidates globally and keeps every source", () => {
  const merged = mergeCandidates([], [
    { handle: "alice", sourceId: "source-a" },
    { handle: "Alice", sourceId: "source-b" },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sourceIds, ["source-a", "source-b"]);
  assert.equal(merged[0].status, "pending_follow");
});

test("prioritizes a due unfollow when choosing the next batch after an inter-batch wait", () => {
  const state = {
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS, batchSize: 50 },
    run: { phase: "idle", activeBatch: null },
    candidates: [{ id: "a", handle: "alice", status: "pending_unfollow", unfollowDueAt: "2026-08-13T00:00:00.000Z" }],
  };
  assert.equal(selectNextBatch(state, new Date("2026-08-13T01:00:00.000Z")).kind, "unfollow");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/followup-model.test.mjs`

Expected: FAIL because `extension/followup-model.js` does not exist.

- [ ] **Step 3: Implement the pure model**

```js
export const DEFAULT_FOLLOWUP_SETTINGS = Object.freeze({
  perSourceLimit: 200,
  backlogMaximum: 500,
  refillThreshold: 100,
  batchSize: 50,
  actionDelayMinSeconds: 10,
  actionDelayMaxSeconds: 20,
  batchDelayMinMinutes: 5,
  batchDelayMaxMinutes: 7,
  unfollowDelayDays: 2,
});

// The engine calls this only when there is no active batch and the inter-batch
// wait has completed; it does not preempt an active batch or its wait.
export function selectNextBatch(state, now) {
  const due = getDueUnfollowCandidates(state, now).slice(0, state.settings.batchSize);
  if (due.length) return { kind: "unfollow", candidateIds: due.map(({ id }) => id) };
  const follows = state.candidates.filter(({ status }) => status === "pending_follow").slice(0, state.settings.batchSize);
  return follows.length ? { kind: "follow", candidateIds: follows.map(({ id }) => id) } : null;
}
```

Implement strict source URL/handle parsing, normalized lowercase dedupe keys, source IDs, state invariant checks, date fields as ISO strings, and a JSON-export object containing exactly `version`, `settings`, `sources`, `candidates`, and `history`. Do not include `run`, `automationEnabled`, credential fields, or any other state fields.

- [ ] **Step 4: Run model tests and existing pure tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the domain model**

```bash
git add extension/followup-model.js test/followup-model.test.mjs package.json
git commit -m "feat: add local follow-up domain model"
```

### Task 2: Persist and export only the local state

**Files:**
- Create: `extension/followup-store.js`
- Create: `test/followup-store.test.mjs`

**Interfaces:**
- Consumes the Task 1 state shape.
- Produces `createFollowupStore({ storage, now })` with `load()`, `save(state)`, `update(mutator)`, `exportJson()`, and `reset()`.
- Persist under one versioned key: `instagramFollowupState`. Legacy Cold DM keys are never read by this store.

- [ ] **Step 1: Write failing persistence tests**

```js
test("migrates a missing state to local defaults without reading Cold DM keys", async () => {
  const calls = [];
  const store = createFollowupStore({ storage: fakeStorage(calls), now: fixedNow });
  const state = await store.load();
  assert.equal(state.version, 1);
  assert.deepEqual(calls[0], ["instagramFollowupState"]);
});

test("export serializes state and reset replaces it with a disabled empty state", async () => {
  const store = createFollowupStore({ storage: fakeStorage(), now: fixedNow });
  const exported = JSON.parse(await store.exportJson());
  assert.deepEqual(Object.keys(exported).sort(), ["candidates", "history", "settings", "sources", "version"]);
  await store.reset();
  assert.equal((await store.load()).automationEnabled, false);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/followup-store.test.mjs`

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement storage serialization**

```js
export function createFollowupStore({ storage, now = () => new Date() }) {
  async function load() {
    const { instagramFollowupState } = await storage.get(["instagramFollowupState"]);
    return normalizeFollowupState(instagramFollowupState, now());
  }
  async function save(state) {
    const normalized = normalizeFollowupState(state, now());
    await storage.set({ instagramFollowupState: normalized });
    return normalized;
  }
  return { load, save, update, exportJson, reset };
}
```

`update` must load, invoke a synchronous pure mutator, validate/normalize the result, then write once. `reset` must create the empty default state and must not call `storage.clear()` so unrelated extension settings cannot be erased.

- [ ] **Step 4: Run persistence and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit local persistence**

```bash
git add extension/followup-store.js test/followup-store.test.mjs
git commit -m "feat: persist local Instagram follow-up state"
```

### Task 3: Extract follower collection as a no-download Instagram adapter

**Files:**
- Create: `extension/instagram-followers.js`
- Create: `test/instagram-followers.test.mjs`
- Modify: `extension/background.js`

**Interfaces:**
- Produces `createInstagramFollowers({ openTabAndWait, executeScript, closeTab, log })` with `collectFollowers({ profileUrl, limit, signal })`.
- Returns `{ candidates: [{ handle, profileUrl, displayName }], warning: string | null }` from the supplied profile's followers only, and never writes storage, exports CSV, opens the supplied profile's Following list, or chooses subsequent work.
- Reuses the currently validated `normalizeInstagramProfileTarget`, `openProfileListModal`, `expandFollowersModalIfNeeded` and `collectProfileListFromDom` logic, moved into the adapter or shared internal functions.

- [ ] **Step 1: Write failing scraper-adapter tests**

```js
test("collects only unique normalized follower handles and closes the profile tab", async () => {
  const closed = [];
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 42 }),
    executeScript: scriptedFollowers(["Alice", "alice", "bob"]),
    closeTab: async (id) => closed.push(id),
    log: () => {},
  });
  const result = await adapter.collectFollowers({ profileUrl: "https://www.instagram.com/source/", limit: 200 });
  assert.deepEqual(result.candidates.map(({ handle }) => handle), ["alice", "bob"]);
  assert.deepEqual(closed, [42]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/instagram-followers.test.mjs`

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Move and narrow the existing follower scraper**

Move the follower-specific DOM/network collection from `background.js` into the adapter. Keep the current handling for Instagram preview/owner-only list warnings. Remove the automatic `downloadScrapeCsv()` call from this path; source collection only returns in-memory candidates to the engine.

- [ ] **Step 4: Run the adapter and full test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the follower adapter**

```bash
git add extension/instagram-followers.js extension/background.js test/instagram-followers.test.mjs
git commit -m "refactor: isolate Instagram follower collection"
```

### Task 4: Add verified single-profile Follow and Unfollow operations

**Files:**
- Create: `extension/instagram-follow-actions.js`
- Create: `test/instagram-follow-actions.test.mjs`

**Interfaces:**
- Produces `performInstagramRelationshipAction({ expectedHandle, action })`, where `action` is exactly `follow` or `unfollow`.
- Returns `{ status: "succeeded" | "skipped" | "failed", reason?, at }`.
- The background opens the expected canonical profile URL and injects this function; the function neither opens tabs nor writes state.

- [ ] **Step 1: Write failing DOM action tests**

```js
test("follows only when the loaded profile handle matches and the visible button changes to Following", async () => {
  installProfileDom({ pathname: "/alice/", initialLabel: "Follow", afterClickLabel: "Following" });
  const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
  assert.equal(result.status, "succeeded");
});

test("does not click an unrelated profile or report success without final state", async () => {
  installProfileDom({ pathname: "/bob/", initialLabel: "Follow" });
  const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
  assert.equal(result.status, "skipped");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/instagram-follow-actions.test.mjs`

Expected: FAIL because the action module does not exist.

- [ ] **Step 3: Implement conservative DOM state checks**

```js
export async function performInstagramRelationshipAction({ expectedHandle, action }) {
  if (!pathnameMatchesInstagramHandle(location.pathname, expectedHandle)) {
    return { status: "skipped", reason: "The loaded profile does not match the queued handle.", at: new Date().toISOString() };
  }
  const button = findVisibleProfileRelationshipButton(action);
  if (!button) return { status: "failed", reason: `Instagram ${action} control was not found.`, at: new Date().toISOString() };
  button.click();
  const confirmed = await waitForRelationshipState(action, 10_000);
  return confirmed ? { status: "succeeded", at: new Date().toISOString() } : { status: "failed", reason: "Instagram did not confirm the new follow state.", at: new Date().toISOString() };
}
```

Scope queries to the visible profile header, ignore drawer/navigation controls, treat already-followed/already-unfollowed state as `skipped`, and use the observed French/English pairs: `Suivre`/`Follow`, `Suivi(e)`/`Following`, `Ne plus suivre`/`Unfollow`, `Annuler`/`Cancel`. Do not use private Instagram endpoints for follow/unfollow.

Keep the Following-list row path only as a defensive helper backed by non-live DOM/UI tests: locate the candidate through its canonical `a[href]` first and search upward through no more than eight ancestors for the nearest visible `Suivi(e)`/`Following` button. Never choose a relationship button from the whole modal: several rows are visible concurrently. After the first click, wait for the confirmation control with the exact `Ne plus suivre`/`Unfollow` label, then require the original row's button to disappear or change to the observed Follow label. The current engine and gateway do not navigate to or invoke this path; queued unfollows run against the candidate's direct canonical profile. This is not a runtime operator-authorization gate.

- [ ] **Step 4: Run focused and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit verified relationship actions**

```bash
git add extension/instagram-follow-actions.js test/instagram-follow-actions.test.mjs
git commit -m "feat: add verified Instagram follow actions"
```

### Task 5: Build the persisted single-pipeline engine

**Files:**
- Create: `extension/followup-engine.js`
- Create: `test/followup-engine.test.mjs`

**Interfaces:**
- Consumes Task 1 model, Task 2 store, Task 3 `collectFollowers`, and Task 4 relationship-action gateway.
- Produces `createFollowupEngine({ store, collectFollowers, performAction, schedule, clearSchedule, now, random })` with `startAuto()`, `pause()`, `resume()`, `stop()`, `addSource(input, limit)`, `runManualSource(sourceId)`, `getState()`, `runDueWork()`.
- `schedule(at, alarmName)` receives an absolute `Date`; only the composition root knows Chrome alarm APIs.

- [ ] **Step 1: Write failing engine behavior tests**

```js
test("fills to the backlog cap, follows a batch, then schedules an inter-batch delay", async () => {
  const harness = createEngineHarness({ sources: [source("source-a")], candidates: [] });
  await harness.engine.startAuto();
  await harness.engine.runDueWork();
  assert.equal(harness.calls.collectFollowers[0].limit, 200);
  assert.equal(harness.calls.performAction.length, 50);
  assert.match(harness.calls.schedule.at(-1).name, /NEXT/);
});

test("defers a due unfollow until the active follow batch completes", async () => {
  const harness = createEngineHarness({ activeBatch: followBatch(), candidates: [dueUnfollow("old-follow")] });
  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction[0].action, "follow");
  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction.at(-1).action, "unfollow");
});

test("stop disables automation and clears the next alarm without deleting candidates", async () => {
  const harness = createEngineHarness({ candidates: [pendingFollow("alice")] });
  await harness.engine.stop();
  assert.equal((await harness.engine.getState()).automationEnabled, false);
  assert.equal((await harness.engine.getState()).candidates.length, 1);
  assert.equal(harness.calls.clearSchedule, 1);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/followup-engine.test.mjs`

Expected: FAIL because the engine module does not exist.

- [ ] **Step 3: Implement engine phases and timing**

Implement phases `idle`, `collecting`, `running_batch`, `waiting`, `paused`, `blocked`, and `stopped`. `runDueWork()` must: verify automation is enabled; avoid concurrent execution with a persisted lease; promote followed candidates due at `now`; finish any active batch one action at a time; respect the 10–20 second action delay; schedule 5–7 minute inter-batch pauses; then, only when choosing the next batch after that active batch and inter-batch wait, prioritize due unfollows before follows; refill sources only below 100 pending follows; and stop source collection at 500 pending follows. A completed source preview caused by Instagram's owner-only restriction is not retried automatically; persist its warning and continue to the next source.

Record every terminal operation in `history` with action, handle, source IDs, status, reason and timestamp. On session/tab/action availability failure, set `blocked`, preserve work, and schedule a later safe retry. On source scrape failure, mark that source `error` with a retryable error and continue to another eligible source.

- [ ] **Step 4: Run engine and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the engine**

```bash
git add extension/followup-engine.js test/followup-engine.test.mjs
git commit -m "feat: add persisted follow-up automation engine"
```

### Task 6: Replace the background service-worker composition root

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/manifest.json`
- Delete: `extension/api-client.js`
- Delete: `extension/result-outbox.js`
- Delete: `extension/result-reporting.js`
- Delete: `extension/platforms.js`
- Delete: `extension/platform-adapters.js`
- Delete: `extension/linkedin-send.js`
- Delete: `extension/linkedin-test-debug-bridge.js`
- Delete: obsolete tests for deleted modules

**Interfaces:**
- Runtime messages: `GET_FOLLOWUP_STATE`, `ADD_SOURCE`, `RUN_MANUAL_SOURCE`, `START_AUTO`, `PAUSE_AUTO`, `RESUME_AUTO`, `STOP_AUTO`, `SAVE_FOLLOWUP_SETTINGS`, `EXPORT_FOLLOWUP_STATE`, `RESET_FOLLOWUP_STATE`.
- Alarm name: `INSTAGRAM_FOLLOWUP_NEXT_WORK`.

- [ ] **Step 1: Write failing runtime-wiring tests**

```js
test("Start Auto delegates to the local engine and never invokes fetch", async () => {
  const { runtime, engine } = installBackgroundHarness();
  const response = await runtime.send({ type: "START_AUTO" });
  assert.deepEqual(response, { ok: true });
  assert.equal(engine.startAutoCalls, 1);
  assert.equal(globalThis.fetchCalls, 0);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/background-followup.test.mjs`

Expected: FAIL because the background still exposes the sender contract.

- [ ] **Step 3: Compose only local dependencies**

Replace the sender/result/outbox listeners with the Task 5 engine. Detect a logged-out Instagram session by opening a temporary Instagram tab, waiting for it to load, checking whether it redirected to login, then closing that temporary tab in `finally`. Implement the relationship gateway by opening one canonical profile tab, waiting for load, injecting Task 4, closing the tab in `finally`, and returning its structured result. Implement `chrome.alarms.onAlarm` for only `INSTAGRAM_FOLLOWUP_NEXT_WORK`; the handler calls `engine.runDueWork()`.

Keep the existing main-world network interception only if Task 3 requires it. Narrow manifest permissions and host permissions to the resulting Instagram-only requirements; remove LinkedIn and wildcard host permissions when no remaining runtime path needs them.

- [ ] **Step 4: Run all tests and static checks**

Run: `npm test && git diff --check`

Expected: all tests pass and no whitespace errors.

- [ ] **Step 5: Commit the new service-worker root**

```bash
git add -A extension test
git commit -m "refactor: replace Cold DM runtime with local follow-up engine"
```

### Task 7: Replace the side panel with the local dashboard

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js`
- Modify: `extension/sidepanel.css`
- Modify: `test/sidepanel.test.mjs`

**Interfaces:**
- Consumes the Task 6 runtime messages and `FollowupState`.
- Produces UI controls: source URL/handle input, per-source limit, `Scrape + Follow`, source-list add/remove controls, `Start Auto`, `Pause`, `Resume`, `Stop`, settings save, export download and confirmed reset.

- [ ] **Step 1: Write failing side-panel tests**

```js
test("manual source scrape sends a local intent and renders backlog progress", async () => {
  await withPanel({ state: dashboardState({ pendingFollows: 73 }) }, async ({ document, messages }) => {
    document.getElementById("source-input").value = "@source";
    await document.getElementById("manual-scrape-button").trigger("click");
    assert.deepEqual(messages.at(-1), { type: "RUN_MANUAL_SOURCE", payload: { input: "@source", limit: 200 } });
    assert.match(document.getElementById("backlog-count").textContent, /73/);
  });
});

test("Stop calls STOP_AUTO and renders automation disabled", async () => {
  await withPanel({ state: dashboardState({ automationEnabled: true }) }, async ({ document, messages }) => {
    await document.getElementById("stop-button").trigger("click");
    assert.equal(messages.at(-1).type, "STOP_AUTO");
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/sidepanel.test.mjs`

Expected: FAIL because the current panel expects a Cold DM API connection and queue.

- [ ] **Step 3: Build the single dashboard**

Remove the connect view, platform selector, campaign queue and Cold DM settings. Render, in order: automation state/control card; manual scrape card; finite source-list card; backlog and active-work progress; due-unfollow count; recent local action history; settings; export/reset controls. Poll `GET_FOLLOWUP_STATE` only while the panel is open and render button enablement from `state.run.phase`.

Use accessible labels and text such as `Start Auto`, `Scrape + Follow`, `Pending follows`, `Due unfollows`, `Pause`, `Resume`, and `Stop`. Before calling reset, use `window.confirm("Reset all local sources, candidates, history, and settings?")`; only send `RESET_FOLLOWUP_STATE` after it returns true. Export must create a Blob from the returned JSON and use a local download named `instagram-followup-export-<ISO date>.json`.

- [ ] **Step 4: Run UI and full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the dashboard**

```bash
git add extension/sidepanel.html extension/sidepanel.js extension/sidepanel.css test/sidepanel.test.mjs
git commit -m "feat: add local Instagram follow-up dashboard"
```

### Task 8: Verify on the authenticated Instagram UI and document local operation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `extension/manifest.json` if selector inspection reveals a required existing permission mismatch

**Interfaces:**
- Documents the local-only state model, defaults, control semantics, known Instagram UI limitations, and the requirement that Instagram must be logged in in the active Chrome profile. It must state that login detection opens a temporary tab, waits for its load, detects a login redirect, then closes the tab.

- [ ] **Step 1: Run all automated verification**

Run: `npm test && git diff --check`

Expected: all tests pass and no whitespace errors.

- [x] **Step 2: Inspect current Instagram controls without a side effect**

Completed on 2026-08-13 in the authenticated French Instagram UI, without a Follow/Unfollow confirmation:

- `noevarner.ai`: the header `104 k followers` link opened a `Followers` dialog; each preview row exposed a canonical profile link plus a `Suivre` button. The dialog warned that only the profile owner can see all followers, so the collected preview is not the full list.
- `alban_nfp`: the header `357 suivi(e)s` link opened a `Suivi(e)s` dialog with a `Rechercher` input; each row exposed a canonical profile link plus a `Suivi(e)` button.
- Clicking a row's `Suivi(e)` button opened the confirmation UI for `_russ3ll_n`, with `Ne plus suivre` and `Annuler`. `Annuler` was clicked; no relationship state was changed.

- [ ] **Step 3: Request explicit authorization immediately before the first state-changing live action**

State the exact test handle and whether the next click is Follow or Unfollow. Do not treat selector inspection or this plan as authorization for that click.

- [ ] **Step 4: Execute the authorized smoke test and verify local state**

After authorization, perform one action only. Verify: the browser shows the expected final relationship state; the local candidate transition and timestamp are correct; exactly one history row is created; no network request is made to Cold DM or another external service; and no second action is scheduled until the configured action delay.

- [ ] **Step 5: Document and commit**

Document that the JSON export contains exactly `version`, `settings`, `sources`, `candidates`, and `history`, and excludes `run` and `automationEnabled`. Document that source collection is followers-only; both runtime relationship actions use the candidate's direct canonical profile, while the defensive Following-list helper has only non-live DOM/UI test coverage and is not wired into the engine or gateway. Document that `Start Auto`, `Resume`, and `Scrape + Follow` can cause live actions, and that the required operator authorization is procedural and external, not a runtime enforcement gate.

```bash
git add README.md docs/architecture.md extension/manifest.json
git commit -m "docs: describe local Instagram follow-up operation"
```

## Final Verification

- [ ] Run `npm test` and record the passing test count.
- [ ] Run `git diff --check`.
- [ ] Inspect `rg -n "coldDm|Cold DM|linkedin|fetch\\(" extension README.md docs/architecture.md` and remove every active-runtime dependency; references limited to historical migration notes are allowed only if clearly labelled historical.
- [ ] Reload the unpacked extension and confirm no connection/API-key screen remains.
- [ ] Confirm the dashboard can add a source, start/pause/resume/stop the local engine, export JSON and reset local state.

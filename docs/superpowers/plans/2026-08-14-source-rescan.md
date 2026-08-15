# Periodic Source Rescan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically re-scan Instagram sources that already finished a full collection pass, on a configurable interval, so new followers keep feeding the existing 50-per-batch follow automation instead of the backlog running dry.

**Architecture:** Add one new settings field (`sourceRescanHours`, default 6). Broaden the engine's existing automatic source-selection and "is there scan work due" checks so a `"completed"` source becomes eligible again once its `lastCollectedAt` is older than that interval — no new source status. Add a matching future-date calculation so the engine's next-alarm scheduling shows an accurate countdown to the next rescan instead of falling through to a distant lifecycle deadline. Wire the same setting into the existing generic Settings form.

**Tech Stack:** Manifest V3 JavaScript modules, Chrome alarms, local follow-up store, Node test runner (`node --test`).

## Global Constraints

- `sourceRescanHours` defaults to `6` and is user-configurable in Settings, like the other duration settings (`unfollowDelayDays`, `followBackUnfollowDelayDays`).
- No new source status: `"completed"` stays the terminal state after every collection pass, including rescans. Eligibility is computed dynamically from `status` + `lastCollectedAt`, never persisted as a separate flag.
- A rescan reuses the source's existing configured `limit` (default `perSourceLimit`, 200) — no growing/deepening quota per rescan.
- Rescans follow the exact same automation-enabled, `backlogMaximum`, and `refillThreshold` gating that already governs regular source scans. No separate on/off switch.
- No per-source rescan interval override — one global setting only.
- Keep follows and unfollows in one global serial lane; never schedule them concurrently (existing project constraint, unaffected by this change).
- Do not perform real Instagram actions during automated verification.

---

### Task 1: Persisted `sourceRescanHours` setting

**Files:**
- Modify: `extension/followup-model.js:1-55`
- Test: `test/followup-model.test.mjs`
- Modify: `test/followup-store.test.mjs:34-45` (default-settings expectation)
- Modify: `test/followup-remote-store.test.mjs:29` (explicit settings literal)

**Interfaces:**
- Produces: `DEFAULT_FOLLOWUP_SETTINGS.sourceRescanHours` (number, default `6`); `sourceRescanHours` added to the `POSITIVE_NUMBER_SETTINGS` validation list, so `validateFollowupSettings` rejects a missing/zero/negative value the same way it already rejects a bad `unfollowDelayDays`.

- [ ] **Step 1: Write the failing tests**

Add to `test/followup-model.test.mjs` (near the other settings tests, e.g. after the `"validates and exports the durable follow-back unfollow delay setting"` test):

```js
test("defaults the automatic source rescan interval to six hours", () => {
  assert.equal(DEFAULT_FOLLOWUP_SETTINGS.sourceRescanHours, 6);
});

test("rejects a non-positive source rescan interval", () => {
  assert.throws(
    () => followupModel.validateFollowupSettings({ ...DEFAULT_FOLLOWUP_SETTINGS, sourceRescanHours: 0 }),
    /positive sourceRescanHours/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/followup-model.test.mjs`

Expected: FAIL — `sourceRescanHours` is `undefined`, and `validateFollowupSettings` does not mention it.

- [ ] **Step 3: Write minimal implementation**

In `extension/followup-model.js`, update `DEFAULT_FOLLOWUP_SETTINGS`:

```js
export const DEFAULT_FOLLOWUP_SETTINGS = Object.freeze({
  perSourceLimit: 200,
  backlogMaximum: 500,
  refillThreshold: 100,
  sourceRescanHours: 6,
  batchSize: 50,
  actionDelayMinSeconds: 5,
  actionDelayMaxSeconds: 10,
  batchDelayMinMinutes: 5,
  batchDelayMaxMinutes: 7,
  unfollowDelayDays: 2,
  followBackUnfollowDelayDays: 7,
});
```

And update `POSITIVE_NUMBER_SETTINGS`:

```js
const POSITIVE_NUMBER_SETTINGS = [
  "actionDelayMinSeconds",
  "actionDelayMaxSeconds",
  "batchDelayMinMinutes",
  "batchDelayMaxMinutes",
  "sourceRescanHours",
  "unfollowDelayDays",
  "followBackUnfollowDelayDays",
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/followup-model.test.mjs`

Expected: PASS.

- [ ] **Step 5: Fix the two tests that assert an exact default-settings shape**

`test/followup-store.test.mjs` asserts the migrated-default state settings object verbatim. In the test `"migrates a missing state to local defaults without reading Cold DM keys"`, add the new field so the object matches the new default:

```js
    settings: {
      perSourceLimit: 200,
      backlogMaximum: 500,
      refillThreshold: 100,
      sourceRescanHours: 6,
      batchSize: 50,
      actionDelayMinSeconds: 5,
      actionDelayMaxSeconds: 10,
      batchDelayMinMinutes: 5,
      batchDelayMaxMinutes: 7,
      unfollowDelayDays: 2,
      followBackUnfollowDelayDays: 7,
    },
```

`test/followup-remote-store.test.mjs` builds a hand-written settings object directly (not spread from `DEFAULT_FOLLOWUP_SETTINGS`) that is fed straight into `buildLocalExport`, which now requires `sourceRescanHours`. In the test `"remote store supports the same export and reset controls as the local store"`, update the literal:

```js
    settings: { perSourceLimit: 200, backlogMaximum: 500, refillThreshold: 100, sourceRescanHours: 6, batchSize: 50, actionDelayMinSeconds: 10, actionDelayMaxSeconds: 20, batchDelayMinMinutes: 5, batchDelayMaxMinutes: 7, unfollowDelayDays: 2, followBackUnfollowDelayDays: 7 },
```

- [ ] **Step 6: Run the affected suites to verify they pass**

Run: `node --test test/followup-model.test.mjs test/followup-store.test.mjs test/followup-remote-store.test.mjs`

Expected: PASS. (Every other settings object in the test suite is built by spreading `DEFAULT_FOLLOWUP_SETTINGS` or is merged with it inside `normalizeFollowupState`/`createEngineHarness`, so it already carries the new default automatically — no further test files need changes for this task.)

- [ ] **Step 7: Commit**

```bash
git add extension/followup-model.js test/followup-model.test.mjs test/followup-store.test.mjs test/followup-remote-store.test.mjs
git commit -m "feat: add configurable source rescan interval setting"
```

---

### Task 2: Automatic rescan eligibility and next-wake scheduling

**Files:**
- Modify: `extension/followup-engine.js:163-184` (source rotation/selection helpers), `:510-542` (scan-work and deadline refresh), `:544-582` (next global work date), `:1020` (refill call site)
- Test: `test/followup-engine.test.mjs`

**Interfaces:**
- Consumes: `state.settings.sourceRescanHours` (Task 1).
- Produces: `isSourceRescanDue(source, now, rescanHours)`, `isSourceScanEligible(source, now, rescanHours)` (new module-level helpers); `nextAutomaticSource(sources, attempted, now, rescanHours)` (extended signature — same name, two new trailing params); `hasSourceScanWork(state, now)` (extended signature — same name, one new param); `nextSourceRescanDate(state, current)` (new closure helper used only inside `nextGlobalWorkDate`).

- [ ] **Step 1: Write the failing tests**

Add to `test/followup-engine.test.mjs`, directly after the existing test `"an automatic source retry rotates behind a source that has waited longer"` (so the new rescan tests sit next to the other automatic-refill-rotation tests):

```js
test("an automatic refill re-collects a completed source once its rescan interval has elapsed", async () => {
  const harness = createEngineHarness({
    sources: [
      source("source-a", {
        status: "completed",
        lastCollectedAt: "2026-08-12T18:00:00.000Z",
        updatedAt: "2026-08-12T18:00:00.000Z",
      }),
    ],
    settings: { sourceRescanHours: 6 },
    collectResults: [{ candidates: handles("fresh", 1), warning: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  assert.deepEqual(harness.calls.collectFollowers.map(({ profileUrl }) => profileUrl), [
    "https://www.instagram.com/source.a/",
  ]);
  assert.ok(harness.rawState().candidates.some(({ handle }) => handle === "fresh0"));
});

test("schedules the next wake for exactly when a completed source becomes eligible for rescan, then re-collects it", async () => {
  const harness = createEngineHarness({
    sources: [
      source("source-a", {
        status: "completed",
        lastCollectedAt: "2026-08-12T20:00:00.000Z",
        updatedAt: "2026-08-12T20:00:00.000Z",
      }),
    ],
    settings: { sourceRescanHours: 6 },
    collectResults: [{ candidates: handles("fresh", 1), warning: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), "2026-08-13T02:00:00.000Z");

  harness.setNow("2026-08-13T02:00:00.000Z");
  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(harness.calls.collectFollowers[0].profileUrl, "https://www.instagram.com/source.a/");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/followup-engine.test.mjs`

Expected: FAIL — a `"completed"` source is never selected by the current automatic refill, so `collectFollowers` is never called in either test, and the first assertion in the first test fails.

- [ ] **Step 3: Write minimal implementation**

In `extension/followup-engine.js`, replace the block from `sourceRotationTimestamp` through `nextAutomaticSource` (currently lines 163-184):

```js
function isSourceRescanDue(source, now, rescanHours) {
  if (source.status !== "completed") return false;
  const lastCollectedMs = Date.parse(source.lastCollectedAt);
  if (!Number.isFinite(lastCollectedMs)) return false;
  return now.getTime() - lastCollectedMs >= rescanHours * 3_600_000;
}

function isSourceScanEligible(source, now, rescanHours) {
  return source.status === "pending"
    || source.status === "error"
    || isSourceRescanDue(source, now, rescanHours);
}

function sourceRotationTimestamp(source) {
  for (const value of [source.lastCollectedAt, source.updatedAt, source.createdAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.POSITIVE_INFINITY;
}

function nextAutomaticSource(sources, attempted, now, rescanHours) {
  let selected = null;
  let selectedTimestamp = Number.POSITIVE_INFINITY;
  for (const source of sources) {
    if (attempted.has(source.id) || !isSourceScanEligible(source, now, rescanHours)) continue;
    const timestamp = sourceRotationTimestamp(source);
    // Keep the persisted list order as a deterministic tie-breaker.
    if (!selected || timestamp < selectedTimestamp) {
      selected = source;
      selectedTimestamp = timestamp;
    }
  }
  return selected;
}
```

Update the call site inside `refillSources` (currently line 1020):

```js
      const source = nextAutomaticSource(state.sources, attempted, currentDate(), state.settings.sourceRescanHours);
```

Replace `hasSourceScanWork` (currently lines 510-525) — only its final, unscoped branch changes; the live-test and explicit-source-retry branches are intentionally left untouched since they target one already-identified source, not general backlog refill:

```js
  function hasSourceScanWork(state, now) {
    if (state.run.liveTestSourceId) {
      return state.sources.some((source) => (
        canonicalSourceId(source.id) === canonicalSourceId(state.run.liveTestSourceId)
        && (source.status === "pending" || source.status === "error")
      ));
    }
    if (state.run.sourceScanSourceId) {
      return state.sources.some((source) => (
        canonicalSourceId(source.id) === canonicalSourceId(state.run.sourceScanSourceId)
        && (source.status === "pending" || source.status === "error")
      ));
    }
    return getPendingFollowCount(state) < state.settings.refillThreshold
      && state.sources.some((source) => isSourceScanEligible(source, now, state.settings.sourceRescanHours));
  }
```

Add a new helper directly after it (mirrors the existing `nextFollowBackReviewDate` pattern):

```js
  function nextSourceRescanDate(state, current) {
    const dueDates = state.sources
      .filter((source) => (
        source.status === "completed"
        && !isSourceRescanDue(source, current, state.settings.sourceRescanHours)
      ))
      .map((source) => new Date(Date.parse(source.lastCollectedAt) + (state.settings.sourceRescanHours * 3_600_000)))
      .filter((date) => Number.isFinite(date.getTime()));
    if (!dueDates.length) return null;
    return earliestDate(dueDates);
  }
```

Update the call site of `hasSourceScanWork` inside `refreshGlobalDeadlines` (currently line 536):

```js
    if (!hasSourceScanWork(state, current)) {
```

Finally, wire `nextSourceRescanDate` into `nextGlobalWorkDate`'s `futureDates` collection (currently lines 572-580):

```js
    if (state.automationEnabled) {
      const lifecycleAt = nextDueLifecycleAt(state, current);
      if (lifecycleAt) {
        const lifecycleDate = validDate(lifecycleAt, "next lifecycle work");
        if (lifecycleDate > current) futureDates.push(lifecycleDate);
      }
      const futureUnfollow = earliestFutureUnfollow(state, current);
      if (futureUnfollow) futureDates.push(futureUnfollow);
      const rescanAt = nextSourceRescanDate(state, current);
      if (rescanAt && rescanAt > current) futureDates.push(rescanAt);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/followup-engine.test.mjs`

Expected: PASS, including every pre-existing test in the file (the eligibility check is additive: `"pending"`/`"error"` sources behave exactly as before).

- [ ] **Step 5: Commit**

```bash
git add extension/followup-engine.js test/followup-engine.test.mjs
git commit -m "feat: automatically rescan completed sources on an interval"
```

---

### Task 3: Settings UI for the rescan interval

**Files:**
- Modify: `extension/sidepanel.js:5-16`
- Modify: `extension/sidepanel.html:169-177`
- Modify: `test/sidepanel.test.mjs:729-752`

**Interfaces:**
- Consumes: `state.settings.sourceRescanHours` (Task 1), the existing generic `SETTING_FIELDS`/`renderSettings`/`readSettings`/`validateSettings`/`saveSettings` machinery (unchanged).
- Produces: `source-rescan-hours-input` DOM element id, registered in `SETTING_FIELDS.sourceRescanHours`.

- [ ] **Step 1: Write the failing test**

Extend the existing test `"Settings persists J+2 and J+7 retention with advanced timing and validates locally"` in `test/sidepanel.test.mjs`:

```js
test("Settings persists J+2 and J+7 retention with advanced timing and validates locally", { concurrency: false }, async () => {
  const state = dashboardState();
  state.settings.batchSize = 25;
  await withPanel({ state }, async ({ document, messages }) => {
    assert.equal(document.getElementById("batch-size-input").value, "25");
    assert.equal(document.getElementById("follow-back-unfollow-delay-days-input").value, "7");
    assert.equal(document.getElementById("source-rescan-hours-input").value, "6");
    assert.match(document.getElementById("advanced-settings").getAttribute("aria-label"), /advanced timing/i);

    document.getElementById("unfollow-delay-days-input").value = "3";
    document.getElementById("follow-back-unfollow-delay-days-input").value = "9";
    document.getElementById("source-rescan-hours-input").value = "12";
    await document.getElementById("settings-save-button").trigger("click");
    assert.deepEqual(messages.at(-1), {
      type: "SAVE_FOLLOWUP_SETTINGS",
      payload: { settings: { ...state.settings, unfollowDelayDays: 3, followBackUnfollowDelayDays: 9, sourceRescanHours: 12 } },
    });

    const saveCount = messages.filter(({ type }) => type === "SAVE_FOLLOWUP_SETTINGS").length;
    document.getElementById("action-delay-min-seconds-input").value = "30";
    document.getElementById("action-delay-max-seconds-input").value = "10";
    await document.getElementById("settings-save-button").trigger("click");
    assert.equal(messages.filter(({ type }) => type === "SAVE_FOLLOWUP_SETTINGS").length, saveCount);
    assert.match(document.getElementById("panel-status").textContent, /minimum.*maximum/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/sidepanel.test.mjs`

Expected: FAIL — `document.getElementById("source-rescan-hours-input")` is `null`, so reading `.value` throws.

- [ ] **Step 3: Write minimal implementation**

In `extension/sidepanel.js`, update `SETTING_FIELDS`:

```js
const SETTING_FIELDS = Object.freeze({
  perSourceLimit: "per-source-limit-input",
  backlogMaximum: "backlog-maximum-input",
  refillThreshold: "refill-threshold-input",
  sourceRescanHours: "source-rescan-hours-input",
  batchSize: "batch-size-input",
  actionDelayMinSeconds: "action-delay-min-seconds-input",
  actionDelayMaxSeconds: "action-delay-max-seconds-input",
  batchDelayMinMinutes: "batch-delay-min-minutes-input",
  batchDelayMaxMinutes: "batch-delay-max-minutes-input",
  unfollowDelayDays: "unfollow-delay-days-input",
  followBackUnfollowDelayDays: "follow-back-unfollow-delay-days-input",
});
```

In `extension/sidepanel.html`, add the input inside the "Advanced timing" grid, next to the refill threshold field:

```html
              <label class="field" for="refill-threshold-input"><span>Refill threshold</span><input id="refill-threshold-input" type="number" min="1" step="1" /></label>
              <label class="field" for="source-rescan-hours-input"><span>Rescan a completed source after (hours)</span><input id="source-rescan-hours-input" type="number" min="1" step="any" /></label>
```

(`sourceRescanHours` is not added to `INTEGER_SETTINGS`, matching `unfollowDelayDays`/`followBackUnfollowDelayDays` — it is validated only as "greater than zero", allowing fractional hours.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/sidepanel.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/sidepanel.js extension/sidepanel.html test/sidepanel.test.mjs
git commit -m "feat: expose the source rescan interval in Settings"
```

---

### Task 4: Full verification

**Files:**
- None (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: zero failures. (The relational-state integration tests in `test/relational-followup-state.test.mjs` are skipped by default — they only run with `FOLLOWUP_SERVICE_DB_TEST=1` against a local Supabase instance — so this plan does not touch the relational schema.)

- [ ] **Step 2: Syntax-check the touched files**

Run: `node --check extension/followup-model.js && node --check extension/followup-engine.js && node --check extension/sidepanel.js`

Expected: no output, exit code 0.

- [ ] **Step 3: Review the diff for stray whitespace or unintended changes**

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Manually verify in the unpacked extension (optional, requires Chrome)**

Reload the unpacked "Instagram Follow-Up" extension in `chrome://extensions`, open its side panel, go to Settings → Advanced timing, and confirm "Rescan a completed source after (hours)" shows `6` and saves correctly. To see it drive real automation without waiting six hours, temporarily set it to a small value (e.g. `0.01`, ~36 seconds) on a test account with one already-`completed` source, enable Autopilot, and confirm the "Up Next" card counts down to a source rescan instead of jumping to a distant follow-back review — then restore the setting.

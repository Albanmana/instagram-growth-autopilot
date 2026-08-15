# Balanced Cycle Source Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every due four-hour balanced cycle collect one rotating source before its unfollows and follows.

**Architecture:** Add a durable `collect` stage to `run.cycle`. A due review records a requested source and uses the existing serialized source lane; successful collection advances to unfollows and follows.

**Tech Stack:** Manifest V3 JavaScript, Chrome alarms, local/revisioned state store, Node test runner.

## Global Constraints

- Every balanced cycle collects one configured source, including with pending follows.
- Sources rotate by least-recently-collected time, then list order.
- Safety deadlines, leases, recovery fences, and 48-hour eligibility remain authoritative.
- A collection failure retries the same source before actions.
- Unit, relational, and both MV3 E2E suites must pass without live Instagram activity.

---

### Task 1: Persist and execute a mandatory collection stage

**Files:**
- Modify: `extension/followup-engine.js:1135-1510`
- Test: `test/followup-engine.test.mjs`

**Interface:** Add `startBalancedCollection(state, at)`. It sets `run.cycle.stage` to `collect`, persists `run.sourceScanSourceId` and `run.nextSourceScanAt`, then calls `runSourceCycle`.

- [ ] **Step 1: Write the failing test**

```js
test("a due balanced cycle collects before following an already queued candidate", async () => {
  const harness = createEngineHarness({
    automationEnabled: true, balancedCycles: true,
    sources: [source("source-a")], candidates: [pendingFollow("queued")],
    cycle: { dueAt: START, stage: "review" },
  });
  await harness.engine.runDueWork();
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(harness.calls.performAction.length, 0);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/followup-engine.test.mjs --test-name-pattern='due balanced cycle collects'`

Expected: FAIL because review currently advances directly to actions.

- [ ] **Step 3: Implement the minimum transition**

```js
function startBalancedCollection(state, at) {
  const source = nextBalancedCycleSource(state);
  if (!source) return beginCycleActions(state, at);
  state = updateRun(state, {
    phase: "waiting", cycle: { ...state.run.cycle, stage: "collect" },
    nextSourceScanAt: at.toISOString(), sourceScanSourceId: source.id,
  }, ["nextWorkAt"]);
  return runSourceCycle(state, { cycle: true });
}
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/followup-engine.test.mjs --test-name-pattern='due balanced cycle collects'`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add extension/followup-engine.js test/followup-engine.test.mjs && git commit -m "feat: collect a source in every balanced cycle"`

### Task 2: Rotate sources and retain the collection through restart

**Files:**
- Modify: `extension/followup-engine.js:200-220,1040-1450`
- Test: `test/followup-engine.test.mjs`

**Interface:** Add `nextBalancedCycleSource(state)`, ignoring the normal six-hour rescan condition while retaining deterministic order. Prefer an already-persisted requested source after restart.

- [ ] **Step 1: Write failing tests**

```js
test("successive balanced cycles rotate mandatory source collection", async () => {
  const harness = createEngineHarness({ automationEnabled: true, balancedCycles: true,
    sources: [source("source-a"), source("source-b")], cycle: { dueAt: START, stage: "review" } });
  await harness.engine.runDueWork();
  await completeCycle(harness);
  await harness.engine.runDueWork();
  assert.deepEqual(harness.calls.collectFollowers.map(({ profileUrl }) => profileUrl), [
    "https://www.instagram.com/source-a/", "https://www.instagram.com/source-b/",
  ]);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/followup-engine.test.mjs --test-name-pattern='rotate mandatory'`

Expected: FAIL because the forced selection and `collect` restart path do not exist.

- [ ] **Step 3: Implement selection and resumption**

```js
function nextBalancedCycleSource(state) {
  return [...state.sources].filter(({ status }) => status !== "collecting")
    .sort((left, right) => sourceRotationTimestamp(left) - sourceRotationTimestamp(right))[0] || null;
}
```

Update `runDueWork` to run the persisted collect request before all action selection.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/followup-engine.test.mjs --test-name-pattern='rotate mandatory'`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add extension/followup-engine.js test/followup-engine.test.mjs && git commit -m "feat: rotate sources across balanced cycles"`

### Task 3: Keep retries bounded and explain collection in the UI

**Files:**
- Modify: `extension/followup-engine.js:1408-1450`
- Modify: `extension/sidepanel.js:465-605`
- Test: `test/followup-engine.test.mjs`, `test/sidepanel.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
test("a balanced collection error retries before following", async () => {
  const harness = createEngineHarness({ automationEnabled: true, balancedCycles: true,
    sources: [source("source-a")], candidates: [pendingFollow("queued")],
    collectFollowers: async () => { throw new Error("temporary source failure"); },
    cycle: { dueAt: START, stage: "review" } });
  await harness.engine.runDueWork();
  assert.equal(harness.rawState().run.cycle.stage, "collect");
  assert.equal(harness.rawState().run.sourceScanSourceId, "source-a");
  assert.equal(harness.calls.performAction.length, 0);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/followup-engine.test.mjs --test-name-pattern='balanced collection error'`

Expected: FAIL because a collect-stage retry is not yet preserved.

- [ ] **Step 3: Implement and update copy**

Keep `cycle.stage === "collect"` and the selected source when collection fails. Change the cycle detail to “Review follow-backs, collect a source, then up to 50 unfollows and 50 follows.”

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/followup-engine.test.mjs test/sidepanel.test.mjs --test-name-pattern='balanced collection error|collect a source'`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add extension/followup-engine.js extension/sidepanel.js test/followup-engine.test.mjs test/sidepanel.test.mjs && git commit -m "fix: retain balanced collection retries"`

### Task 4: Verify the live extension build

- [ ] **Step 1: Run all checks**

Run: `npm test && npm run test:service-db && npm run test:e2e && npm run test:e2e:service`

Expected: all pass and E2E reports no Instagram activity.

- [ ] **Step 2: Reload the exact unpacked extension**

At `chrome://extensions/`, reload `Instagram Follow-Up`, require Chrome text `Extension actualisée`, then inspect `chrome-extension://mldhdiailafielbfdmmejlmadjoiapoo/sidepanel.html` for the expanded cycle wording.

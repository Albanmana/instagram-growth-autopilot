import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FOLLOWUP_SETTINGS } from "../extension/followup-model.js";
import * as followupEngine from "../extension/followup-engine.js";
import { createFollowupStore } from "../extension/followup-store.js";

const { createFollowupEngine } = followupEngine;

const START = "2026-08-13T01:00:00.000Z";

function source(id, overrides = {}) {
  return {
    id,
    profileUrl: `https://www.instagram.com/${id.replaceAll("-", ".")}/`,
    limit: 200,
    status: "pending",
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

function pendingFollow(handle, sourceIds = ["source-a"]) {
  return {
    id: `instagram:${handle}`,
    handle,
    profileUrl: `https://www.instagram.com/${handle}/`,
    normalizedHandle: handle.toLowerCase(),
    sourceIds,
    status: "pending_follow",
    createdAt: START,
    updatedAt: START,
  };
}

function dueUnfollow(handle, sourceIds = ["source-old"]) {
  return {
    ...pendingFollow(handle, sourceIds),
    status: "followed",
    followedAt: "2026-08-10T01:00:00.000Z",
    followBackStatus: "unknown",
    followBackReviewDueAt: "2026-08-12T01:00:00.000Z",
    lastFollowBackCheckAt: "2026-08-12T01:00:00.000Z",
    unfollowDueAt: "2026-08-12T01:00:00.000Z",
  };
}

function followed(handle, overrides = {}) {
  return {
    ...pendingFollow(handle),
    status: "followed",
    followedAt: "2026-08-11T01:00:00.000Z",
    followBackStatus: "unknown",
    followBackReviewDueAt: START,
    unfollowDueAt: START,
    ...overrides,
  };
}

function handles(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ handle: `${prefix}${index}` }));
}

function createEngineHarness({
  sources = [],
  candidates = [],
  history = [],
  activeBatch = null,
  automationEnabled = false,
  phase = activeBatch ? "running_batch" : "idle",
  lease,
  nextWorkAt,
  nextSourceScanAt,
  sourceScanSourceId,
  nextRelationshipReviewAt,
  safetyDeadlineAt,
  inflightAction,
  externalOperation,
  cycle,
  liveTestSourceId,
  liveTestCandidateIds,
  collectResults = [],
  relationshipResults = [],
  directOutcomes = null,
  actionResults = [],
  randomValues = [0],
  settings = {},
  balancedCycles = false,
} = {}) {
  let clock = new Date(START);
  let state = {
    version: 1,
    automationEnabled,
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS, ...settings },
    sources: structuredClone(sources),
    candidates: structuredClone(candidates),
    run: {
      phase,
      activeBatch: structuredClone(activeBatch),
      ...(lease ? { lease: structuredClone(lease) } : {}),
      ...(nextWorkAt ? { nextWorkAt } : {}),
      ...(nextSourceScanAt ? { nextSourceScanAt } : {}),
      ...(sourceScanSourceId ? { sourceScanSourceId } : {}),
      ...(nextRelationshipReviewAt ? { nextRelationshipReviewAt } : {}),
      ...(safetyDeadlineAt ? { safetyDeadlineAt } : {}),
      ...(inflightAction ? { inflightAction: structuredClone(inflightAction) } : {}),
      ...(externalOperation ? { externalOperation: structuredClone(externalOperation) } : {}),
      ...(cycle ? { cycle: structuredClone(cycle) } : {}),
      ...(liveTestSourceId ? { liveTestSourceId, liveTestCandidateIds: structuredClone(liveTestCandidateIds || []) } : {}),
    },
    history: structuredClone(history),
  };
  const calls = {
    collectFollowers: [],
    collectOwnFollowerHandles: [],
    collectAndFollowFollowers: [],
    directPersistedStates: [],
    performAction: [],
    schedule: [],
    clearSchedule: 0,
    saves: [],
  };
  const queuedCollections = [...collectResults];
  const queuedRelationshipReviews = [...relationshipResults];
  const queuedActions = [...actionResults];
  const queuedRandom = [...randomValues];

  const store = {
    async load() {
      return structuredClone(state);
    },
    async save(nextState) {
      state = structuredClone(nextState);
      calls.saves.push(structuredClone(state));
      return structuredClone(state);
    },
    async update(mutator) {
      return this.save(mutator(structuredClone(state)));
    },
  };
  const collectFollowers = async (input) => {
    calls.collectFollowers.push(structuredClone(input));
    const scripted = queuedCollections.shift();
    if (scripted instanceof Error) throw scripted;
    return structuredClone(scripted ?? { candidates: [], warning: null });
  };
  const collectOwnFollowerHandles = async (input) => {
    calls.collectOwnFollowerHandles.push(structuredClone(input));
    const scripted = queuedRelationshipReviews.shift();
    if (scripted instanceof Error) throw scripted;
    return structuredClone(scripted ?? { handles: [], warning: null });
  };
  const performAction = async (input) => {
    calls.performAction.push(structuredClone(input));
    const scripted = queuedActions.shift();
    if (typeof scripted === "function") return scripted(input);
    if (scripted instanceof Error) throw scripted;
    return structuredClone(scripted ?? { status: "succeeded", at: clock.toISOString() });
  };
  const collectAndFollowFollowers = async ({ profileUrl, limit, onOutcome, signal }) => {
    calls.collectAndFollowFollowers.push({ profileUrl, limit, signal });
    for (const outcome of directOutcomes || []) {
      await onOutcome(structuredClone(outcome));
      calls.directPersistedStates.push(structuredClone(state));
    }
    return { processedCount: (directOutcomes || []).length, warning: null };
  };
  const schedule = async (at, name, options) => {
    calls.schedule.push({ at: new Date(at), name, options });
  };
  const clearSchedule = async () => {
    calls.clearSchedule += 1;
  };
  const random = () => queuedRandom.length > 1 ? queuedRandom.shift() : (queuedRandom[0] ?? 0);
  const engine = createFollowupEngine({
    store,
    collectFollowers,
    collectOwnFollowerHandles,
    ...(directOutcomes === null ? {} : { collectAndFollowFollowers }),
    performAction,
    schedule,
    clearSchedule,
    balancedCycles,
    now: () => new Date(clock),
    random,
  });

  return {
    engine,
    calls,
    rawState() {
      return structuredClone(state);
    },
    setNow(value) {
      clock = new Date(value);
    },
    advanceToLastSchedule() {
      assert.ok(calls.schedule.length > 0, "expected scheduled work");
      clock = new Date(calls.schedule.at(-1).at);
    },
  };
}

function memoryStorage(initialState) {
  const data = { instagramFollowupState: structuredClone(initialState) };
  return {
    data,
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      return Object.fromEntries(keys.map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(data, structuredClone(values));
    },
  };
}

function independentStore(shared) {
  return {
    async load() {
      return structuredClone(shared.state);
    },
    async save(nextState) {
      shared.state = structuredClone(nextState);
      return structuredClone(shared.state);
    },
    async update(mutator) {
      shared.state = structuredClone(mutator(structuredClone(shared.state)));
      return structuredClone(shared.state);
    },
  };
}

test("action-spacing alarms carry a safety intent", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice")],
  });
  await harness.engine.startAuto();
  await harness.engine.runDueWork();
  assert.equal(harness.calls.schedule.at(-1).options?.safety, true);
});

test("a future balanced cycle keeps queued follows dormant across service-worker startup", async () => {
  const cycleDueAt = "2026-08-13T05:00:00.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    candidates: [pendingFollow("alice")],
    cycle: { dueAt: cycleDueAt, stage: "review" },
  });

  await harness.engine.reconcileStartup();

  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.rawState().run.nextWorkAt, cycleDueAt);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), cycleDueAt);

  harness.setNow(cycleDueAt);
  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction.length, 1);
  assert.equal(harness.calls.performAction[0].action, "follow");
});

test("a due balanced cycle collects before following an already queued candidate", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    sources: [source("source-a")],
    candidates: [pendingFollow("queued")],
    cycle: { dueAt: START, stage: "review" },
  });

  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(harness.calls.collectFollowers[0].profileUrl, "https://www.instagram.com/source.a/");
  assert.equal(harness.calls.performAction.length, 1);
  assert.equal(harness.calls.performAction[0].action, "follow");
});

test("successive balanced cycles rotate mandatory source collection", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    sources: [source("source-a"), source("source-b")],
    cycle: { dueAt: START, stage: "review" },
  });

  await harness.engine.runDueWork();
  harness.advanceToLastSchedule();
  await harness.engine.runDueWork();

  assert.deepEqual(harness.calls.collectFollowers.map(({ profileUrl }) => profileUrl), [
    "https://www.instagram.com/source.a/",
    "https://www.instagram.com/source.b/",
  ]);
});

test("a restarted worker retains a pending balanced collection before action work", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    sources: [source("source-a")],
    candidates: [pendingFollow("queued")],
    cycle: { dueAt: START, stage: "collect" },
    sourceScanSourceId: "source-a",
    nextSourceScanAt: START,
  });

  await harness.engine.reconcileStartup();
  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(harness.calls.performAction.length, 1);
});

test("a balanced collection error retries the same source before following", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    sources: [source("source-a")],
    candidates: [pendingFollow("queued")],
    collectResults: [new Error("temporary source failure")],
    cycle: { dueAt: START, stage: "review" },
  });

  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(state.run.cycle.stage, "collect");
  assert.equal(state.run.sourceScanSourceId, "source-a");
  assert.ok(state.run.nextSourceScanAt);
  assert.equal(harness.calls.performAction.length, 0);
});

test("running the next balanced cycle now advances its persisted deadline without acting inline", async () => {
  const cycleDueAt = "2026-08-13T05:00:00.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    candidates: [pendingFollow("alice")],
    cycle: { dueAt: cycleDueAt, stage: "review" },
  });

  await harness.engine.runNextCycleNow();

  assert.equal(harness.rawState().run.cycle.dueAt, "2026-08-13T01:00:00.000Z");
  assert.equal(harness.rawState().run.nextWorkAt, "2026-08-13T01:00:00.000Z");
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), "2026-08-13T01:00:00.000Z");
  assert.equal(harness.calls.performAction.length, 0);
});

test("running the next balanced cycle now preserves a future safety deadline", async () => {
  const safetyDeadlineAt = "2026-08-13T01:10:00.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    candidates: [pendingFollow("alice")],
    cycle: { dueAt: "2026-08-13T05:00:00.000Z", stage: "review" },
    safetyDeadlineAt,
  });

  await harness.engine.runNextCycleNow();

  assert.equal(harness.rawState().run.cycle.dueAt, "2026-08-13T01:00:00.000Z");
  assert.equal(harness.rawState().run.nextWorkAt, safetyDeadlineAt);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), safetyDeadlineAt);
  assert.equal(harness.calls.performAction.length, 0);
});

test("running the next balanced cycle now enters its mandatory source collection", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    sources: [source("source-a")],
    candidates: [pendingFollow("queued")],
    cycle: { dueAt: "2026-08-13T05:00:00.000Z", stage: "review" },
  });

  await harness.engine.runNextCycleNow();
  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(harness.calls.performAction.length, 1);
});

test("balanced cycle reviews, unfollows confirmed follow-backs, follows, then waits four hours", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    settings: { cycleIntervalHours: 4, activeFollowCap: 1000 },
    candidates: [followed("returning"), pendingFollow("new")],
    relationshipResults: [{ handles: ["returning"], warning: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  assert.deepEqual(harness.calls.performAction.map(({ action }) => action), ["unfollow", "follow"]);
  const state = harness.rawState();
  assert.equal(state.candidates.find(({ handle }) => handle === "returning").status, "unfollowed");
  assert.equal(state.candidates.find(({ handle }) => handle === "new").status, "followed");
  assert.deepEqual(state.run.cycle, { dueAt: "2026-08-13T05:00:00.000Z", stage: "review" });
});

test("balanced cycle drains eligible unfollows but blocks follows at the active cap", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    settings: { cycleIntervalHours: 4, activeFollowCap: 1 },
    candidates: [dueUnfollow("due"), followed("held", { unfollowDueAt: "2026-08-15T01:00:00.000Z" }), pendingFollow("new")],
    relationshipResults: [{ handles: [], warning: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  assert.deepEqual(harness.calls.performAction.map(({ action }) => action), ["unfollow"]);
  assert.equal(harness.rawState().candidates.find(({ handle }) => handle === "new").status, "pending_follow");
});

test("startup gives an already-running legacy autopilot a persisted calendar cycle", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    candidates: [pendingFollow("alice")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
  });

  await harness.engine.reconcileStartup();

  assert.deepEqual(harness.rawState().run.cycle, {
    dueAt: START,
    stage: "follow",
  });
});

test("startup persists the legacy calendar cycle before waiting for a foreign worker lease", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    balancedCycles: true,
    candidates: [pendingFollow("alice")],
    lease: {
      ownerId: "previous-worker",
      expiresAt: "2026-08-13T01:15:00.000Z",
    },
  });

  await harness.engine.reconcileStartup({ serviceWorkerActivated: true });

  assert.deepEqual(harness.rawState().run.cycle, {
    dueAt: START,
    stage: "review",
  });
  assert.equal(harness.calls.performAction.length, 0);
});

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("fills the backlog cap, follows a batch one alarm at a time, then schedules an inter-batch delay", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a"), source("source-b"), source("source-c")],
    collectResults: [
      { candidates: handles("a", 200), warning: null },
      { candidates: handles("b", 200), warning: null },
      { candidates: handles("c", 200), warning: null },
    ],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();
  assert.deepEqual(harness.calls.collectFollowers.map(({ limit }) => limit), [200, 200, 100]);
  assert.equal((await harness.engine.getState()).candidates.length, 500);

  while ((await harness.engine.getState()).run.activeBatch) {
    harness.advanceToLastSchedule();
    await harness.engine.runDueWork();
  }

  assert.equal(harness.calls.performAction.length, 50);
  assert.match(harness.calls.schedule.at(-1).name, /NEXT/);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), "2026-08-13T01:09:05.000Z");
  const state = await harness.engine.getState();
  assert.equal(state.run.phase, "waiting");
  assert.equal(state.history[0].reason, null);
});

test("defers a due unfollow until the active follow batch and global inter-batch wait complete", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    activeBatch: { kind: "follow", candidateIds: ["instagram:new.follow"] },
    candidates: [pendingFollow("new.follow"), dueUnfollow("old.follow")],
  });

  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction[0].action, "follow");
  assert.equal((await harness.engine.getState()).run.phase, "waiting");

  harness.advanceToLastSchedule();
  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction.at(-1).action, "unfollow");
});

test("uses the exact random action and inter-batch timing ranges", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice"), pendingFollow("bob")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice", "instagram:bob"] },
    randomValues: [1, 1],
  });

  await harness.engine.runDueWork();
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), "2026-08-13T01:00:10.000Z");
  harness.advanceToLastSchedule();
  await harness.engine.runDueWork();
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), "2026-08-13T01:07:10.000Z");
});

test("serializes concurrent due-work calls while the persisted running phase is visible", async () => {
  let release;
  const actionGate = new Promise((resolve) => { release = resolve; });
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    actionResults: [async () => {
      await actionGate;
      return { status: "succeeded", at: START };
    }],
  });

  const first = harness.engine.runDueWork();
  const second = harness.engine.runDueWork();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.performAction.length, 1);
  assert.equal((await harness.engine.getState()).run.phase, "running_batch");
  release();
  await Promise.all([first, second]);
  assert.equal(harness.calls.performAction.length, 1);
});

test("stores a preview warning as terminal and continues after a source scrape error", async () => {
  const ownerWarning = "Instagram limited this followers list. Only the account owner can see the full followers list for this profile.";
  const harness = createEngineHarness({
    sources: [source("source-error"), source("source-preview"), source("source-good")],
    collectResults: [
      new Error("followers modal unavailable"),
      { candidates: [], warning: ownerWarning },
      { candidates: handles("good", 120), warning: null },
    ],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(state.sources.find(({ id }) => id === "source-error").status, "error");
  assert.match(state.sources.find(({ id }) => id === "source-error").warning, /retryable/i);
  assert.equal(state.sources.find(({ id }) => id === "source-preview").status, "completed");
  assert.equal(state.sources.find(({ id }) => id === "source-preview").warning, ownerWarning);
  assert.equal(state.sources.find(({ id }) => id === "source-good").status, "completed");
  assert.equal(harness.calls.collectFollowers.length, 3);
});

test("logs a failed action, skips that candidate, and continues the batch after six seconds", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice"), pendingFollow("bob")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice", "instagram:bob"] },
    actionResults: [
      { status: "failed", reason: "Instagram follow control was not found.", at: START },
      { status: "succeeded", at: "2026-08-13T01:05:00.000Z" },
    ],
    settings: { actionDelayMinSeconds: 6, actionDelayMaxSeconds: 6 },
  });

  await harness.engine.runDueWork();
  let state = await harness.engine.getState();
  assert.equal(state.run.phase, "running_batch");
  assert.deepEqual(state.run.activeBatch.candidateIds, ["instagram:bob"]);
  assert.equal(state.candidates[0].status, "skipped");
  assert.deepEqual(state.history.at(-1), {
    candidateId: "instagram:alice",
    action: "follow",
    kind: "follow",
    handle: "alice",
    sourceIds: ["source-a"],
    status: "failed",
    reason: "Instagram follow control was not found.",
    timestamp: START,
    at: START,
  });
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), "2026-08-13T01:00:06.000Z");

  harness.advanceToLastSchedule();
  await harness.engine.runDueWork();
  state = await harness.engine.getState();
  assert.equal(state.candidates[0].status, "skipped");
  assert.equal(state.candidates[1].status, "followed");
  assert.equal(harness.calls.performAction.length, 2);
});

test("records terminal action history with handle, source IDs, reason, status and timestamp", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice", ["source-a", "source-b"])],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    actionResults: [{ status: "skipped", reason: "The Instagram profile is already followed.", at: START }],
  });

  await harness.engine.runDueWork();
  const [entry] = (await harness.engine.getState()).history;
  assert.deepEqual(entry, {
    candidateId: "instagram:alice",
    action: "follow",
    kind: "follow",
    handle: "alice",
    sourceIds: ["source-a", "source-b"],
    status: "skipped",
    reason: "The Instagram profile is already followed.",
    timestamp: START,
    at: START,
  });
});

test("does not retroactively decorate legacy terminal history from mutable candidate data", async () => {
  const storageData = {};
  const store = createFollowupStore({
    storage: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
      },
      async set(values) {
        Object.assign(storageData, values);
      },
    },
    now: () => new Date(START),
  });
  await store.save({
    version: 1,
    automationEnabled: false,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [],
    candidates: [pendingFollow("alice", ["source-a"])],
    run: { phase: "idle", activeBatch: null },
    history: [{ candidateId: "instagram:alice", kind: "follow", status: "failed", at: START, reason: "Legacy." }],
  });
  const engine = createFollowupEngine({
    store,
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async () => ({ status: "skipped", reason: "Already followed." }),
    schedule: async () => {},
    clearSchedule: async () => {},
    now: () => new Date(START),
    random: () => 0,
  });

  const [entry] = (await engine.getState()).history;

  assert.equal(entry.action, undefined);
  assert.equal(entry.handle, undefined);
  assert.equal(entry.sourceIds, undefined);
  assert.equal(entry.timestamp, undefined);
  assert.equal(entry.kind, "follow");
  assert.equal(entry.at, START);
  assert.equal(entry.reason, "Legacy.");
});

test("pause, resume and stop preserve queued candidates and control the next alarm", async () => {
  const harness = createEngineHarness({ candidates: [pendingFollow("alice")] });

  await harness.engine.startAuto();
  await harness.engine.pause();
  assert.equal((await harness.engine.getState()).run.phase, "paused");
  await harness.engine.resume();
  assert.equal((await harness.engine.getState()).automationEnabled, true);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), START);
  await harness.engine.stop();

  const state = await harness.engine.getState();
  assert.equal(state.automationEnabled, false);
  assert.equal(state.run.phase, "stopped");
  assert.equal(state.candidates.length, 1);
  assert.equal(harness.calls.clearSchedule, 2);
});

test("pause and stop persist safety controls and clear the alarm despite a foreign lease", async () => {
  const lease = { ownerId: "other-worker", expiresAt: "2026-08-13T01:15:00.000Z" };

  for (const control of ["pause", "stop"]) {
    const harness = createEngineHarness({
      automationEnabled: true,
      phase: "waiting",
      lease,
      nextWorkAt: lease.expiresAt,
      nextSourceScanAt: START,
      sources: [source("source-a")],
    });

    await harness.engine[control]();

    const state = harness.rawState();
    assert.equal(state.run.phase, control === "pause" ? "paused" : "stopped", control);
    assert.equal(state.automationEnabled, control === "pause", control);
    assert.equal(harness.calls.clearSchedule, 1, control);
    assert.equal(harness.calls.schedule.length, 0, control);
    if (control === "stop") {
      assert.equal(state.run.nextWorkAt, undefined);
      assert.equal(state.run.nextSourceScanAt, undefined);
      assert.equal(state.run.sourceScanSourceId, undefined);
    }
  }
});

test("a cross-worker Pause or Stop fences the leased action from restoring automation", async () => {
  for (const control of ["pause", "stop"]) {
    const shared = {
      state: {
        version: 1,
        automationEnabled: true,
        settings: DEFAULT_FOLLOWUP_SETTINGS,
        sources: [],
        candidates: [pendingFollow("alice")],
        run: {
          phase: "running_batch",
          activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
        },
        history: [],
      },
    };
    const actionStore = independentStore(shared);
    const controlStore = independentStore(shared);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let actionStarted = false;
    const scheduled = [];
    let cleared = 0;
    const dependencies = {
      collectFollowers: async () => ({ candidates: [], warning: null }),
      collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
      performAction: async () => {
        actionStarted = true;
        await gate;
        return { status: "succeeded", at: START };
      },
      schedule: async (at) => { scheduled.push(new Date(at)); },
      clearSchedule: async () => { cleared += 1; },
      now: () => new Date(START),
      random: () => 0,
    };
    const actionEngine = createFollowupEngine({ ...dependencies, store: actionStore });
    const controlEngine = createFollowupEngine({ ...dependencies, store: controlStore });

    const action = actionEngine.runDueWork();
    await waitUntil(() => actionStarted, `expected gated action before ${control}`);
    await controlEngine[control]();
    assert.equal(shared.state.run.lease, undefined, control);
    release();
    await assert.rejects(action, /lease ownership was lost/i);

    assert.equal(shared.state.run.phase, control === "pause" ? "paused" : "stopped", control);
    assert.equal(shared.state.automationEnabled, control === "pause", control);
    assert.equal(shared.state.run.nextWorkAt, undefined, control);
    assert.equal(shared.state.history.length, 0, control);
    assert.equal(scheduled.length, 0, control);
    assert.equal(cleared, 1, control);
  }
});

test("Pause then Resume still waits for the fenced owner after its lease expires", async () => {
  const leaseExpiry = "2026-08-13T01:15:00.000Z";
  let clock = new Date(START);
  const shared = {
    state: {
      version: 1,
      automationEnabled: true,
      settings: DEFAULT_FOLLOWUP_SETTINGS,
      sources: [],
      candidates: [pendingFollow("alice")],
      run: {
        phase: "running_batch",
        activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
      },
      history: [],
    },
  };
  const actionStore = independentStore(shared);
  const controlStore = independentStore(shared);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let actionCalls = 0;
  const scheduled = [];
  const dependencies = {
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async () => {
      actionCalls += 1;
      if (actionCalls === 1) await gate;
      return { status: "succeeded", at: clock.toISOString() };
    },
    schedule: async (at) => { scheduled.push(new Date(at)); },
    clearSchedule: async () => {},
    now: () => new Date(clock),
    random: () => 0,
  };
  const actionEngine = createFollowupEngine({ ...dependencies, store: actionStore });
  const controlEngine = createFollowupEngine({ ...dependencies, store: controlStore });

  const originalAction = actionEngine.runDueWork();
  await waitUntil(() => actionCalls === 1, "expected the original action to reach its gate");
  await controlEngine.pause();
  await controlEngine.resume();

  try {
    await controlEngine.runDueWork();
    assert.equal(actionCalls, 1, "Resume must not overlap the fenced action");
    assert.equal(shared.state.run.safetyDeadlineAt, leaseExpiry);
    assert.equal(shared.state.run.nextWorkAt, leaseExpiry);
    assert.equal(scheduled.at(-1).toISOString(), leaseExpiry);

    clock = new Date(leaseExpiry);
    await controlEngine.runDueWork();
    assert.equal(actionCalls, 1, "lease expiry must not overlap the still-running fenced action");
  } finally {
    release();
    const [originalResult] = await Promise.allSettled([originalAction]);
    assert.equal(originalResult.status, "rejected");
    assert.match(originalResult.reason.message, /lease ownership was lost/i);
  }

  assert.equal(shared.state.history.length, 0);
  clock = new Date(leaseExpiry);
  await controlEngine.runDueWork();
  assert.equal(actionCalls, 2, "the persisted intent may be recovered only after its fence");
  assert.equal(shared.state.candidates[0].status, "followed");
});

test("Pause after lease expiry keeps a long direct pass fenced until collection exits", async () => {
  let clock = new Date(START);
  const shared = {
    state: {
      version: 1,
      automationEnabled: true,
      settings: DEFAULT_FOLLOWUP_SETTINGS,
      sources: [source("instagram-source:source", {
        profileUrl: "https://www.instagram.com/source/",
        limit: 1,
      })],
      candidates: [],
      run: {
        phase: "idle",
        activeBatch: null,
        nextSourceScanAt: START,
      },
      history: [],
    },
  };
  const collectionStore = independentStore(shared);
  const controlStore = independentStore(shared);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let collectionCalls = 0;
  const scheduled = [];
  const dependencies = {
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    collectAndFollowFollowers: async () => {
      collectionCalls += 1;
      if (collectionCalls === 1) await gate;
      return { processedCount: 0, warning: null };
    },
    performAction: async () => ({ status: "succeeded", at: clock.toISOString() }),
    schedule: async (at) => { scheduled.push(new Date(at)); },
    clearSchedule: async () => {},
    now: () => new Date(clock),
    random: () => 0,
  };
  const collectionEngine = createFollowupEngine({ ...dependencies, store: collectionStore });
  const controlEngine = createFollowupEngine({ ...dependencies, store: controlStore });

  const originalCollection = collectionEngine.runDueWork();
  await waitUntil(() => collectionCalls === 1, "expected the original direct pass to reach its gate");
  clock = new Date("2026-08-13T01:16:00.000Z");
  await controlEngine.pause();
  await controlEngine.resume();

  try {
    await controlEngine.runDueWork();
    assert.equal(collectionCalls, 1, "Resume must not overlap the still-running direct pass");
  } finally {
    release();
    const [originalResult] = await Promise.allSettled([originalCollection]);
    assert.equal(originalResult.status, "rejected");
    assert.match(originalResult.reason.message, /lease ownership was lost/i);
  }

  await controlEngine.runDueWork();
  assert.equal(collectionCalls, 2, "the interrupted source may retry only after its direct pass exits");
  assert.equal(shared.state.sources[0].status, "completed");
});

test("Resume and Start Auto take over a controlled state with a stale foreign lease", async () => {
  for (const scenario of [
    { phase: "paused", automationEnabled: true, method: "resume" },
    { phase: "stopped", automationEnabled: false, method: "startAuto" },
  ]) {
    const harness = createEngineHarness({
      automationEnabled: scenario.automationEnabled,
      phase: scenario.phase,
      lease: { ownerId: "stale-worker", expiresAt: "2026-08-13T01:15:00.000Z" },
      candidates: [pendingFollow("alice")],
    });

    await harness.engine[scenario.method]();

    let state = harness.rawState();
    assert.equal(state.automationEnabled, true, scenario.method);
    assert.equal(state.run.phase, "idle", scenario.method);
    assert.equal(state.run.lease, undefined, scenario.method);
    assert.equal(state.run.nextWorkAt, START, scenario.method);
    assert.equal(harness.calls.schedule.at(-1).at.toISOString(), START, scenario.method);

    await harness.engine.runDueWork();
    state = harness.rawState();
    assert.equal(harness.calls.performAction.length, 1, scenario.method);
    assert.equal(state.candidates[0].status, "followed", scenario.method);
  }
});

test("resume refreshes newly pending source work instead of inheriting a future lifecycle wake", async () => {
  const lifecycleAt = "2026-08-20T01:00:00.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "paused",
    nextWorkAt: lifecycleAt,
    sources: [source("source-a")],
    candidates: [followed("alice", {
      followBackStatus: "confirmed",
      followBackAt: START,
      unfollowDueAt: lifecycleAt,
    })],
  });

  await harness.engine.resume();

  const state = harness.rawState();
  assert.equal(state.run.nextSourceScanAt, START);
  assert.equal(state.run.nextWorkAt, START);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), START);
});

test("adds normalized sources and permits explicit manual collection while automation is disabled", async () => {
  const harness = createEngineHarness({
    collectResults: [{ candidates: [{ handle: "Alice" }], warning: null }],
  });

  const added = await harness.engine.addSource(" @Source.Example ", 25);
  await harness.engine.runManualSource(added.id);
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(added.profileUrl, "https://www.instagram.com/source.example/");
  assert.equal(added.limit, 25);
  assert.equal(state.sources[0].status, "completed");
  assert.equal(state.candidates[0].normalizedHandle, "alice");
  assert.equal(state.run.phase, "idle");
});

test("Manual persists every direct modal outcome before the adapter advances and never uses the profile gateway", async () => {
  const harness = createEngineHarness({
    sources: [source("instagram-source:source", {
      profileUrl: "https://www.instagram.com/source/",
      limit: 3,
    })],
    directOutcomes: [
      { handle: "Alice", displayName: "Alice A.", status: "succeeded", reason: null },
      { handle: "Bob", status: "skipped", reason: "already-following" },
      { handle: "Carol", status: "failed", reason: "missing-row-control" },
    ],
    settings: { actionDelayMinSeconds: 0.001, actionDelayMaxSeconds: 0.001 },
  });

  await harness.engine.runManualSource("instagram-source:source");
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.deepEqual(state.candidates.map(({ normalizedHandle, status }) => ({ normalizedHandle, status })), [
    { normalizedHandle: "alice", status: "followed" },
    { normalizedHandle: "bob", status: "skipped" },
    { normalizedHandle: "carol", status: "failed" },
  ]);
  assert.equal(state.candidates[0].followedAt, START);
  assert.equal(state.candidates[0].unfollowDueAt, "2026-08-15T01:00:00.000Z");
  assert.deepEqual(state.history.map(({ handle, status, reason }) => ({ handle, status, reason })), [
    { handle: "Alice", status: "succeeded", reason: null },
    { handle: "Bob", status: "skipped", reason: "already-following" },
    { handle: "Carol", status: "failed", reason: "missing-row-control" },
  ]);
  assert.deepEqual(
    harness.calls.directPersistedStates.map(({ history }) => history.length),
    [1, 2, 3],
  );
  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.calls.schedule[0].at.toISOString(), START);
  assert.equal(harness.calls.schedule.length, 4);
});

test("a resumed direct pass keeps an already-followed candidate eligible for delayed unfollow", async () => {
  const followed = dueUnfollow("alice", ["instagram-source:source"]);
  followed.unfollowDueAt = "2026-08-15T01:00:00.000Z";
  const harness = createEngineHarness({
    sources: [source("instagram-source:source", {
      profileUrl: "https://www.instagram.com/source/",
      limit: 1,
    })],
    candidates: [followed],
    directOutcomes: [
      { handle: "alice", status: "skipped", reason: "already-following" },
    ],
    settings: { actionDelayMinSeconds: 0.001, actionDelayMaxSeconds: 0.001 },
  });

  await harness.engine.runManualSource("instagram-source:source");
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.candidates[0].followedAt, "2026-08-10T01:00:00.000Z");
  assert.equal(state.candidates[0].unfollowDueAt, "2026-08-15T01:00:00.000Z");
  assert.deepEqual(state.history.map(({ status, reason }) => ({ status, reason })), [{
    status: "skipped",
    reason: "already-following",
  }]);
});

test("a private-account follow request is durable success and remains eligible for follow-back review", async () => {
  const harness = createEngineHarness({
    sources: [source("instagram-source:source", {
      profileUrl: "https://www.instagram.com/source/",
      limit: 1,
    })],
    directOutcomes: [{ handle: "alice", status: "follow_request_sent", reason: null }],
    settings: { actionDelayMinSeconds: 0.001, actionDelayMaxSeconds: 0.001 },
  });

  await harness.engine.runManualSource("instagram-source:source");
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.history[0].status, "follow_request_sent");
  assert.equal(state.candidates[0].followBackStatus, "unknown");
});

test("an unaccepted private follow request is reviewed and then unfollowed after J+2", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    sources: [source("instagram-source:source", {
      profileUrl: "https://www.instagram.com/source/",
      limit: 1,
    })],
    directOutcomes: [{ handle: "privatealice", status: "follow_request_sent", reason: null }],
    relationshipResults: [{ handles: [], warning: null }],
    settings: { actionDelayMinSeconds: 0.001, actionDelayMaxSeconds: 0.001 },
  });

  await harness.engine.runDueWork();
  harness.setNow("2026-08-15T01:00:00.000Z");

  await harness.engine.runDueWork();
  let state = harness.rawState();
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.candidates[0].followBackStatus, "unknown");
  assert.equal(harness.calls.performAction.length, 0);

  await harness.engine.runDueWork();
  state = harness.rawState();
  assert.equal(harness.calls.performAction[0].action, "unfollow");
  assert.equal(state.candidates[0].status, "unfollowed");
});

test("Auto persists direct modal follows without queuing a profile-per-follower follow", async () => {
  const harness = createEngineHarness({
    sources: [source("instagram-source:source", {
      profileUrl: "https://www.instagram.com/source/",
      limit: 1,
    })],
    directOutcomes: [
      { handle: "alice", status: "succeeded", reason: null },
      { handle: "bob", status: "failed", reason: "missing-row-control" },
    ],
    settings: { actionDelayMinSeconds: 0.001, actionDelayMaxSeconds: 0.001 },
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.candidates[1].status, "failed");
  assert.equal(state.history[0].action, "follow");
  assert.equal(harness.calls.collectAndFollowFollowers.length, 1);
  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal(harness.calls.performAction.length, 0);
});

test("a live direct pass records exactly its own visible candidate IDs", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    sources: [source("source-test", { id: "instagram-source:test", profileUrl: "https://www.instagram.com/test/", limit: 10 })],
    candidates: [pendingFollow("older", ["instagram-source:test"])],
    liveTestSourceId: "instagram-source:test",
    directOutcomes: [{ handle: "fresh", status: "succeeded" }],
  });
  await harness.engine.runDueWork();
  const state = await harness.engine.getState();
  assert.deepEqual(state.run.liveTestCandidateIds, ["instagram:fresh"]);
  assert.equal(state.run.activeBatch, null);
});

test("a live direct pass excludes a previously followed skipped row from its unfollow scope", async () => {
  const existing = dueUnfollow("already", ["instagram-source:test"]);
  const harness = createEngineHarness({
    automationEnabled: true,
    sources: [source("source-test", { id: "instagram-source:test", profileUrl: "https://www.instagram.com/test/", limit: 10 })],
    candidates: [existing],
    liveTestSourceId: "instagram-source:test",
    directOutcomes: [
      { handle: "already", status: "skipped", reason: "already-following" },
      { handle: "fresh", status: "succeeded" },
    ],
    settings: { actionDelayMinSeconds: 0.001, actionDelayMaxSeconds: 0.001 },
  });

  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.deepEqual(state.run.liveTestCandidateIds, ["instagram:fresh"]);
  assert.equal(state.candidates.find(({ id }) => id === "instagram:already").status, "followed");
});

test("startLiveTest atomically resets only the chosen source and candidate set", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a", { id: "instagram-source:one", collectionDepth: 99, status: "completed" }), source("source-b", { id: "instagram-source:two", collectionDepth: 3, status: "completed" })],
    candidates: [pendingFollow("older", ["instagram-source:one"])],
  });
  await harness.engine.startLiveTest("instagram-source:one", 10);
  const state = await harness.engine.getState();
  assert.equal(state.automationEnabled, true);
  assert.equal(state.run.liveTestSourceId, "instagram-source:one");
  assert.deepEqual(state.run.liveTestCandidateIds, []);
  assert.deepEqual(state.sources.map(({ id, limit, status, collectionDepth }) => ({ id, limit, status, collectionDepth })), [
    { id: "instagram-source:one", limit: 10, status: "pending", collectionDepth: 0 },
    { id: "instagram-source:two", limit: 200, status: "completed", collectionDepth: 3 },
  ]);
});

test("a completed live test never refills or opens an unrelated pending source", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    liveTestSourceId: "instagram-source:live",
    liveTestCandidateIds: ["instagram:live.done"],
    sources: [
      source("live", { id: "instagram-source:live", status: "completed", collectionDepth: 10 }),
      source("legacy", { id: "instagram-source:legacy", status: "pending" }),
    ],
    candidates: [{
      ...pendingFollow("live.done", ["instagram-source:live"]),
      status: "skipped",
    }],
  });

  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal((await harness.engine.getState()).sources.find(({ id }) => id === "instagram-source:legacy").status, "pending");
});

test("stopping a live test clears its bounded scheduler fence", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    liveTestSourceId: "instagram-source:live",
    liveTestCandidateIds: ["instagram:live.done"],
    sources: [source("live", { id: "instagram-source:live", status: "completed" })],
  });

  await harness.engine.stopLiveTest();

  const state = await harness.engine.getState();
  assert.equal(state.automationEnabled, false);
  assert.equal(state.run.phase, "stopped");
  assert.equal(Object.hasOwn(state.run, "liveTestSourceId"), false);
  assert.equal(Object.hasOwn(state.run, "liveTestCandidateIds"), false);
});

test("Pause and Stop abort direct modal collection while retaining its durable delay deadline", async () => {
  for (const control of ["pause", "stop"]) {
    const harness = createEngineHarness({
      sources: [source("instagram-source:source", {
        profileUrl: "https://www.instagram.com/source/",
        limit: 1,
      })],
      directOutcomes: [{ handle: "alice", status: "succeeded", reason: null }],
      settings: { actionDelayMinSeconds: 10, actionDelayMaxSeconds: 10 },
    });

    await harness.engine.runManualSource("instagram-source:source");
    const collection = harness.engine.runDueWork();
    await waitUntil(() => harness.rawState().run.safetyDeadlineAt, "expected a durable direct-action deadline");
    const deadline = harness.rawState().run.safetyDeadlineAt;
    const controlled = harness.engine[control]();

    await collection;
    await controlled;

    const state = await harness.engine.getState();
    assert.equal(harness.calls.collectAndFollowFollowers[0].signal.aborted, true, control);
    assert.equal(state.run.safetyDeadlineAt, deadline, control);
    assert.equal(state.run.phase, control === "pause" ? "paused" : "stopped", control);
  }
});

test("deduplicates source additions by one case-insensitive canonical ID while honoring a new manual limit", async () => {
  const harness = createEngineHarness();

  const first = await harness.engine.addSource("@Source.Example", 25);
  const second = await harness.engine.addSource("https://instagram.com/source.example/", 50);

  const state = await harness.engine.getState();
  assert.equal(first.id, "instagram-source:source.example");
  assert.equal(second.id, first.id);
  assert.equal(second.limit, 50);
  assert.equal(state.sources.length, 1);
  assert.equal(state.sources[0].limit, 50);
});

test("manual source lookup and replacement use the canonical source ID", async () => {
  const harness = createEngineHarness({
    sources: [source("instagram-source:source.example", {
      profileUrl: "https://www.instagram.com/source.example/",
    })],
    collectResults: [{ candidates: [], warning: null }],
  });

  await harness.engine.runManualSource(" INSTAGRAM-SOURCE:SOURCE.EXAMPLE ");
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(state.sources[0].status, "completed");
});

test("removes a source through a case-insensitive canonical ID", async () => {
  const harness = createEngineHarness({
    sources: [source("instagram-source:source.example", {
      profileUrl: "https://www.instagram.com/source.example/",
    })],
  });

  await harness.engine.removeSource(" INSTAGRAM-SOURCE:SOURCE.EXAMPLE ");

  assert.deepEqual((await harness.engine.getState()).sources, []);
});

test("distinct store wrappers over one backend let only one engine perform a gated action", async () => {
  const initialState = {
    version: 1,
    automationEnabled: true,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [],
    candidates: [pendingFollow("alice")],
    run: {
      phase: "running_batch",
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    },
    history: [],
  };
  const storage = memoryStorage(initialState);
  const firstStore = createFollowupStore({ storage, now: () => new Date(START) });
  const secondStore = createFollowupStore({ storage, now: () => new Date(START) });
  const actions = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dependencies = {
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async (input) => {
      actions.push(input);
      await gate;
      return { status: "succeeded", at: START };
    },
    schedule: async () => {},
    clearSchedule: async () => {},
    now: () => new Date(START),
    random: () => 0,
  };
  const first = createFollowupEngine({ ...dependencies, store: firstStore });
  const second = createFollowupEngine({ ...dependencies, store: secondStore });

  const firstRun = first.runDueWork();
  await waitUntil(() => actions.length === 1, "expected the first action to reach its gate");
  const secondRun = second.runDueWork();
  await new Promise((resolve) => setImmediate(resolve));

  try {
    assert.equal(actions.length, 1);
  } finally {
    release();
    await Promise.allSettled([firstRun, secondRun]);
  }

  assert.equal(actions.length, 1);
  assert.equal(storage.data.instagramFollowupState.history.length, 1);
  assert.equal(storage.data.instagramFollowupState.candidates[0].status, "followed");
});

test("respects a foreign lease until its persisted expiry and then takes ownership", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    lease: {
      ownerId: "other-worker",
      expiresAt: "2026-08-13T01:15:00.000Z",
    },
  });

  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), "2026-08-13T01:15:00.000Z");

  harness.setNow("2026-08-13T01:15:00.000Z");
  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction.length, 1);
  assert.equal(harness.rawState().run.lease, undefined);
});

test("ignores a foreign lease's stale work deadline and schedules only its future expiry", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    nextWorkAt: "2026-08-13T01:00:10.000Z",
    lease: {
      ownerId: "other-worker",
      expiresAt: "2026-08-13T01:15:00.000Z",
    },
  });
  harness.setNow("2026-08-13T01:00:11.000Z");

  await harness.engine.runDueWork();

  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.calls.schedule.length, 1);
  assert.equal(harness.calls.schedule[0].at.toISOString(), "2026-08-13T01:15:00.000Z");
});

test("refuses early wakes for action and inter-batch deadlines", async () => {
  const actionDelay = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice"), pendingFollow("bob")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice", "instagram:bob"] },
  });
  await actionDelay.engine.runDueWork();
  assert.equal(actionDelay.rawState().run.nextWorkAt, "2026-08-13T01:00:05.000Z");
  await actionDelay.engine.runDueWork();
  assert.equal(actionDelay.calls.performAction.length, 1);

  actionDelay.advanceToLastSchedule();
  await actionDelay.engine.runDueWork();
  assert.equal(actionDelay.rawState().run.nextWorkAt, "2026-08-13T01:05:05.000Z");
  actionDelay.setNow("2026-08-13T01:04:59.000Z");
  await actionDelay.engine.runDueWork();
  assert.equal(actionDelay.calls.performAction.length, 2);

});

test("Stop preserves action and inter-batch safety deadlines that Start Auto must honor", async () => {
  const cases = [
    {
      name: "action delay",
      candidates: [pendingFollow("alice"), pendingFollow("bob")],
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice", "instagram:bob"] },
      expectedDeadline: "2026-08-13T01:00:05.000Z",
      restartAt: "2026-08-13T01:00:01.000Z",
    },
    {
      name: "inter-batch delay",
      candidates: [pendingFollow("alice")],
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
      expectedDeadline: "2026-08-13T01:05:00.000Z",
      restartAt: "2026-08-13T01:01:00.000Z",
    },
  ];

  for (const scenario of cases) {
    const harness = createEngineHarness({
      automationEnabled: true,
      candidates: scenario.candidates,
      activeBatch: scenario.activeBatch,
    });
    await harness.engine.runDueWork();
    assert.equal(harness.rawState().run.nextWorkAt, scenario.expectedDeadline, scenario.name);

    await harness.engine.stop();
    assert.equal(harness.rawState().run.nextWorkAt, undefined, scenario.name);
    assert.equal(harness.rawState().run.safetyDeadlineAt, scenario.expectedDeadline, scenario.name);

    harness.setNow(scenario.restartAt);
    await harness.engine.startAuto();
    assert.equal(harness.calls.schedule.at(-1).at.toISOString(), scenario.expectedDeadline, scenario.name);
    assert.equal(harness.rawState().run.nextWorkAt, scenario.expectedDeadline, scenario.name);
  }
});

test("queues stop, pause and addSource calls made while an action is in flight", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    actionResults: [async () => {
      await gate;
      return { status: "succeeded", at: START };
    }],
  });

  const action = harness.engine.runDueWork();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(harness.rawState().run.lease.ownerId, /^followup-engine:/);
  assert.equal(harness.rawState().run.lease.expiresAt, "2026-08-13T01:15:00.000Z");
  const add = harness.engine.addSource("queued.source", 25);
  const pause = harness.engine.pause();
  const stop = harness.engine.stop();
  release();
  await Promise.all([action, add, pause, stop]);

  const state = await harness.engine.getState();
  assert.equal(state.sources.some(({ id }) => id === "instagram-source:queued.source"), true);
  assert.equal(state.automationEnabled, false);
  assert.equal(state.run.phase, "stopped");
  assert.equal(state.history.length, 1);
});

test("distinct wrappers persist addSource, pause and stop after a gated leased action", async () => {
  const initialState = {
    version: 1,
    automationEnabled: true,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [],
    candidates: [pendingFollow("alice")],
    run: {
      phase: "running_batch",
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    },
    history: [],
  };
  const storage = memoryStorage(initialState);
  const actionStore = createFollowupStore({ storage, now: () => new Date(START) });
  const controlStore = createFollowupStore({ storage, now: () => new Date(START) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let actionStarted = false;
  let clearedSchedules = 0;
  const dependencies = {
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async () => {
      actionStarted = true;
      await gate;
      return { status: "succeeded", at: START };
    },
    schedule: async () => {},
    clearSchedule: async () => { clearedSchedules += 1; },
    now: () => new Date(START),
    random: () => 0,
  };
  const actionEngine = createFollowupEngine({ ...dependencies, store: actionStore });
  const controlEngine = createFollowupEngine({ ...dependencies, store: controlStore });

  const action = actionEngine.runDueWork();
  await waitUntil(() => actionStarted, "expected the leased action to reach its gate");
  const add = controlEngine.addSource("queued.source", 25);
  const pause = controlEngine.pause();
  const stop = controlEngine.stop();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [, added] = await Promise.all([action, add, pause, stop]);

  const state = await actionEngine.getState();
  assert.equal(added.id, "instagram-source:queued.source");
  assert.equal(state.sources.some(({ id }) => id === added.id), true);
  assert.equal(state.automationEnabled, false);
  assert.equal(state.run.phase, "stopped");
  assert.equal(state.run.nextWorkAt, undefined);
  assert.equal(state.history.length, 1);
  assert.equal(clearedSchedules, 2);
});

test("distinct wrappers serialize settings behind a gated action without losing either write", async () => {
  const initialState = {
    version: 1,
    automationEnabled: true,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [],
    candidates: [pendingFollow("alice")],
    run: {
      phase: "running_batch",
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    },
    history: [],
  };
  const storage = memoryStorage(initialState);
  const actionStore = createFollowupStore({ storage, now: () => new Date(START) });
  const settingsStore = createFollowupStore({ storage, now: () => new Date(START) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let actionStarted = false;
  const dependencies = {
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async () => {
      actionStarted = true;
      await gate;
      return { status: "succeeded", at: START };
    },
    schedule: async () => {},
    clearSchedule: async () => {},
    now: () => new Date(START),
    random: () => 0,
  };
  const actionEngine = createFollowupEngine({ ...dependencies, store: actionStore });
  const settingsEngine = createFollowupEngine({ ...dependencies, store: settingsStore });

  const action = actionEngine.runDueWork();
  await waitUntil(() => actionStarted, "expected the leased action to reach its gate");
  const saveSettings = settingsEngine.saveSettings({ batchSize: 25, unfollowDelayDays: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(storage.data.instagramFollowupState.settings.batchSize, 50);

  release();
  await Promise.all([action, saveSettings]);

  const state = await actionEngine.getState();
  assert.equal(state.settings.batchSize, 25);
  assert.equal(state.settings.unfollowDelayDays, 3);
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.history.length, 1);
});

test("rejects invalid settings without persisting them", async () => {
  const invalidSettings = [
    undefined,
    null,
    [],
    { unsupportedSetting: 1 },
    { perSourceLimit: 0 },
    { backlogMaximum: -1 },
    { refillThreshold: 500 },
    { batchSize: 0 },
    { actionDelayMinSeconds: 21, actionDelayMaxSeconds: 20 },
    { batchDelayMinMinutes: 8, batchDelayMaxMinutes: 7 },
    { unfollowDelayDays: 0 },
  ];

  for (const settings of invalidSettings) {
    const harness = createEngineHarness();
    await assert.rejects(harness.engine.saveSettings(settings), /settings|backlog|delay/i);
    assert.deepEqual((await harness.engine.getState()).settings, DEFAULT_FOLLOWUP_SETTINGS);
    assert.equal(harness.calls.saves.length, 0);
  }
});

test("shortening the rescan interval reschedules an enabled completed source immediately", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a", {
      status: "completed",
      lastCollectedAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    })],
    settings: { sourceRescanHours: 6 },
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();
  assert.equal(harness.rawState().run.nextWorkAt, "2026-08-13T06:00:00.000Z");

  await harness.engine.saveSettings({ sourceRescanHours: 1 });

  assert.equal(harness.rawState().run.nextWorkAt, START);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), START);
});

test("recovers an interrupted collecting source after a worker restart", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "collecting",
    sources: [source("source-a", { status: "collecting" })],
    collectResults: [{ candidates: [{ handle: "recovered" }], warning: null }],
  });

  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(state.sources[0].status, "completed");
  assert.equal(state.candidates[0].handle, "recovered");
});

test("startup reconciliation repairs interrupted collection and recreates its missing alarm without collecting", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "collecting",
    sources: [source("source-a", { status: "collecting" })],
    collectResults: [{ candidates: [{ handle: "recovered" }], warning: null }],
  });

  await harness.engine.reconcileStartup();

  let state = await harness.engine.getState();
  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal(state.sources[0].status, "pending");
  assert.match(state.sources[0].warning, /interrupted/i);
  assert.equal(state.run.phase, "idle");
  assert.equal(state.run.nextWorkAt, START);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), START);

  await harness.engine.runDueWork();
  state = await harness.engine.getState();
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(state.candidates[0].handle, "recovered");
});

test("startup reconciliation recreates a persisted future alarm without running work early", async () => {
  const nextWorkAt = "2026-08-13T01:05:00.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "waiting",
    nextWorkAt,
    safetyDeadlineAt: nextWorkAt,
    candidates: [pendingFollow("alice")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
  });

  await harness.engine.reconcileStartup();

  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.calls.schedule.length, 1);
  assert.equal(harness.calls.schedule[0].at.toISOString(), nextWorkAt);
  assert.equal(harness.rawState().run.nextWorkAt, nextWorkAt);
});

test("startup reconciliation rebuilds a missing active batch from an exact persisted in-flight intent", async () => {
  const intent = {
    id: "follow:instagram:alice:2026-08-13T00:59:59.000Z",
    candidateId: "instagram:alice",
    action: "follow",
    startedAt: "2026-08-13T00:59:59.000Z",
  };
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "running_batch",
    candidates: [{ ...pendingFollow("alice"), status: "following" }],
    inflightAction: intent,
    actionResults: [({ actionContext }) => ({
      status: "skipped",
      code: "already_desired",
      reason: "The Instagram profile is already followed.",
      intentId: actionContext.intentId,
      at: START,
    })],
  });

  await harness.engine.reconcileStartup();

  let state = await harness.engine.getState();
  assert.deepEqual(state.run.activeBatch, {
    kind: "follow",
    candidateIds: ["instagram:alice"],
  });
  assert.equal(state.run.nextWorkAt, START);

  await harness.engine.runDueWork();
  state = await harness.engine.getState();
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.history[0].status, "succeeded");
});

test("an isolated service-worker activation skips an interrupted action without repeating it", async () => {
  const shared = {
    state: {
      version: 1,
      automationEnabled: true,
      settings: DEFAULT_FOLLOWUP_SETTINGS,
      sources: [],
      candidates: [pendingFollow("alice")],
      run: {
        phase: "running_batch",
        activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
      },
      history: [],
    },
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let actionCalls = 0;
  const scheduled = [];
  const dependencies = {
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async () => {
      actionCalls += 1;
      if (actionCalls === 1) await gate;
      return { status: "succeeded", at: START };
    },
    schedule: async (at, name) => scheduled.push({ at: new Date(at), name }),
    clearSchedule: async () => {},
    now: () => new Date(START),
    random: () => 0,
  };
  const actionContext = await import(new URL(
    "../extension/followup-engine.js?isolated-action-context",
    import.meta.url,
  ));
  const activationContext = await import(new URL(
    "../extension/followup-engine.js?isolated-activation-context",
    import.meta.url,
  ));
  const actionEngine = actionContext.createFollowupEngine({
    ...dependencies,
    store: independentStore(shared),
  });
  const startupEngine = activationContext.createFollowupEngine({
    ...dependencies,
    store: independentStore(shared),
  });

  const originalAction = actionEngine.runDueWork();
  await waitUntil(() => actionCalls === 1, "expected the original action to reach its gate");

  try {
    await startupEngine.reconcileStartup({ serviceWorkerActivated: true });
    await startupEngine.runDueWork();

    assert.equal(actionCalls, 1, "activation must not repeat an unresolved external action");
    assert.equal(shared.state.run.phase, "idle");
    assert.equal(shared.state.run.externalOperation, undefined);
    assert.equal(shared.state.run.lease, undefined);
    assert.equal(shared.state.candidates[0].status, "skipped");
    assert.equal(shared.state.history.at(-1).status, "failed");
  } finally {
    release();
    await Promise.allSettled([originalAction]);
  }

  assert.equal(actionCalls, 1);
  assert.equal(shared.state.history.length, 1);
  assert.equal(shared.state.candidates[0].status, "skipped");
  assert.equal(shared.state.run.externalOperation, undefined);
  assert.equal(shared.state.run.phase, "idle");
});

test.skip("late source completion cannot start another automatic collection after recovery", async () => {
  const shared = {
    state: {
      version: 1,
      automationEnabled: true,
      settings: DEFAULT_FOLLOWUP_SETTINGS,
      sources: [source("source-a"), source("source-b")],
      candidates: [],
      run: { phase: "idle", activeBatch: null },
      history: [],
    },
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const collections = [];
  const scheduled = [];
  const dependencies = {
    collectFollowers: async ({ profileUrl }) => {
      collections.push(profileUrl);
      if (collections.length === 1) await gate;
      return { candidates: [], warning: null };
    },
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async () => ({ status: "succeeded", at: START }),
    schedule: async (at, name) => scheduled.push({ at: new Date(at), name }),
    clearSchedule: async () => {},
    now: () => new Date(START),
    random: () => 0,
  };
  const collectionContext = await import(new URL(
    "../extension/followup-engine.js?isolated-collection-context",
    import.meta.url,
  ));
  const activationContext = await import(new URL(
    "../extension/followup-engine.js?isolated-collection-activation-context",
    import.meta.url,
  ));
  const collectionEngine = collectionContext.createFollowupEngine({
    ...dependencies,
    store: independentStore(shared),
  });
  const startupEngine = activationContext.createFollowupEngine({
    ...dependencies,
    store: independentStore(shared),
  });

  const originalCollection = collectionEngine.runDueWork();
  await waitUntil(() => collections.length === 1, "expected the original collection to reach its gate");
  await startupEngine.reconcileStartup({ serviceWorkerActivated: true });
  release();
  await originalCollection;

  assert.equal(collections.length, 1);
  assert.equal(shared.state.sources[0].status, "completed");
  assert.equal(shared.state.sources[1].status, "pending");
  assert.equal(shared.state.run.phase, "recovery_required");
  assert.equal(shared.state.run.nextWorkAt, undefined);
  assert.equal(scheduled.length, 0);
});

test.skip("recovery during a direct pass delay aborts onOutcome before another row action", async () => {
  const shared = {
    state: {
      version: 1,
      automationEnabled: true,
      settings: {
        ...DEFAULT_FOLLOWUP_SETTINGS,
        actionDelayMinSeconds: 0.25,
        actionDelayMaxSeconds: 0.25,
      },
      sources: [source("source-a")],
      candidates: [],
      run: { phase: "idle", activeBatch: null },
      history: [],
    },
  };
  let directActionCount = 0;
  let directSignal = null;
  let onOutcomeRejected = false;
  const dependencies = {
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    collectAndFollowFollowers: async ({ onOutcome, signal }) => {
      directSignal = signal;
      for (const handle of ["alice", "bob"]) {
        if (signal.aborted) throw signal.reason;
        directActionCount += 1;
        try {
          await onOutcome({ handle, status: "succeeded" });
        } catch (error) {
          onOutcomeRejected = true;
          throw error;
        }
        if (signal.aborted) throw signal.reason;
      }
      return { processedCount: directActionCount, warning: null };
    },
    performAction: async () => ({ status: "succeeded", at: START }),
    schedule: async () => {},
    clearSchedule: async () => {},
    now: () => new Date(START),
    random: () => 0,
  };
  const collectionContext = await import(new URL(
    "../extension/followup-engine.js?isolated-direct-delay-context",
    import.meta.url,
  ));
  const activationContext = await import(new URL(
    "../extension/followup-engine.js?isolated-direct-delay-activation-context",
    import.meta.url,
  ));
  const collectionEngine = collectionContext.createFollowupEngine({
    ...dependencies,
    store: independentStore(shared),
  });
  const startupEngine = activationContext.createFollowupEngine({
    ...dependencies,
    store: independentStore(shared),
  });

  const originalCollection = collectionEngine.runDueWork();
  await waitUntil(
    () => shared.state.history.length === 1 && Boolean(shared.state.run.nextWorkAt),
    "expected the first direct outcome to enter its durable inter-row delay",
  );
  await startupEngine.reconcileStartup({ serviceWorkerActivated: true });
  await originalCollection;

  assert.equal(directActionCount, 1);
  assert.equal(onOutcomeRejected, true);
  assert.equal(directSignal.aborted, true);
  assert.equal(shared.state.candidates.length, 1);
  assert.equal(shared.state.candidates[0].handle, "alice");
  assert.equal(shared.state.history.length, 1);
  assert.equal(shared.state.run.phase, "recovery_required");
  assert.equal(shared.state.run.nextWorkAt, undefined);
});

test("resolving an interrupted operation logs and skips it without blocking automation", async () => {
  const intent = {
    id: "follow:instagram:alice:2026-08-13T00:59:59.000Z",
    candidateId: "instagram:alice",
    action: "follow",
    startedAt: "2026-08-13T00:59:59.000Z",
  };
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "running_batch",
    candidates: [{ ...pendingFollow("alice"), status: "following" }],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    inflightAction: intent,
    externalOperation: {
      id: "action:old-worker:1",
      ownerId: "old-worker",
      kind: "action",
      startedAt: intent.startedAt,
    },
    lease: {
      ownerId: "old-worker",
      expiresAt: "2026-08-13T01:15:00.000Z",
    },
  });

  await harness.engine.resolveInterruptedOperation();

  const state = harness.rawState();
  assert.equal(state.run.phase, "idle");
  assert.equal(state.run.externalOperation, undefined);
  assert.equal(state.run.inflightAction, undefined);
  assert.equal(state.run.lease, undefined);
  assert.equal(state.candidates[0].status, "skipped");
  assert.deepEqual(state.history.at(-1), {
    candidateId: "instagram:alice",
    action: "follow",
    kind: "follow",
    handle: "alice",
    sourceIds: ["source-a"],
    status: "failed",
    reason: "Skipped automatically after an interrupted follow action.",
    timestamp: START,
    at: START,
  });
  assert.equal(harness.calls.clearSchedule, 0);

  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.rawState().run.phase, "idle");
});

test.skip("ordinary controls preserve recovery without scheduling or external work", async () => {
  const intent = {
    id: "follow:instagram:alice:2026-08-13T00:59:59.000Z",
    candidateId: "instagram:alice",
    action: "follow",
    startedAt: "2026-08-13T00:59:59.000Z",
  };
  const controls = ["pause", "stop", "resume", "startAuto", "runDueWork"];

  for (const control of controls) {
    const harness = createEngineHarness({
      automationEnabled: true,
      phase: "recovery_required",
      candidates: [{ ...pendingFollow("alice"), status: "following" }],
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
      inflightAction: intent,
      externalOperation: {
        id: "action:old-worker:1",
        ownerId: "old-worker",
        kind: "action",
        startedAt: intent.startedAt,
      },
      lease: {
        ownerId: "old-worker",
        expiresAt: "2026-08-13T01:15:00.000Z",
      },
    });

    await harness.engine[control]();

    const state = harness.rawState();
    assert.equal(state.run.phase, "recovery_required", control);
    assert.equal(state.automationEnabled, true, control);
    assert.equal(state.run.externalOperation.ownerId, "old-worker", control);
    assert.equal(state.run.lease.ownerId, "old-worker", control);
    assert.equal(state.run.nextWorkAt, undefined, control);
    assert.equal(harness.calls.schedule.length, 0, control);
    assert.equal(harness.calls.performAction.length, 0, control);
    assert.equal(harness.calls.collectFollowers.length, 0, control);
    assert.equal(harness.calls.collectOwnFollowerHandles.length, 0, control);
  }
});

test("direct source controls are no-ops while recovery is required", async () => {
  for (const control of ["scanNow", "runManualSource"]) {
    const harness = createEngineHarness({
      automationEnabled: true,
      phase: "recovery_required",
      sources: [source("source-a", { status: "completed" })],
      externalOperation: {
        id: "source_collection:old-worker:1",
        ownerId: "old-worker",
        kind: "source_collection",
        startedAt: "2026-08-13T00:59:59.000Z",
      },
      lease: {
        ownerId: "old-worker",
        expiresAt: "2026-08-13T01:15:00.000Z",
      },
    });
    const before = harness.rawState();

    await harness.engine[control]("source-a");

    assert.deepEqual(harness.rawState(), before, control);
    assert.equal(harness.calls.schedule.length, 0, control);
    assert.equal(harness.calls.clearSchedule, 0, control);
    assert.equal(harness.calls.collectAndFollowFollowers.length, 0, control);
    assert.equal(harness.calls.collectFollowers.length, 0, control);
    assert.equal(harness.calls.performAction.length, 0, control);
  }
});

test("startup reconciliation turns an orphan transient candidate without an intent into a retry", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "running_batch",
    candidates: [{ ...pendingFollow("alice"), status: "following" }],
  });

  await harness.engine.reconcileStartup();

  const state = await harness.engine.getState();
  assert.equal(state.candidates[0].status, "failed");
  assert.equal(state.candidates[0].nextAction, "follow");
  assert.equal(state.candidates[0].failedAt, START);
  assert.equal(state.run.nextWorkAt, START);
});

test("recovers an already-desired action only from its persisted in-flight intent", async () => {
  const intent = {
    id: "follow:instagram:alice:2026-08-13T00:59:59.000Z",
    candidateId: "instagram:alice",
    action: "follow",
    startedAt: "2026-08-13T00:59:59.000Z",
  };
  const interrupted = {
    ...pendingFollow("alice"),
    status: "following",
  };
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [interrupted],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    inflightAction: intent,
    actionResults: [({ actionContext }) => ({
      status: "skipped",
      code: "already_desired",
      reason: "The Instagram profile is already followed.",
      intentId: actionContext.intentId,
      at: START,
    })],
  });

  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(harness.calls.performAction[0].actionContext.recoveringPersistedIntent, true);
  assert.equal(harness.calls.performAction[0].actionContext.intentId, intent.id);
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.candidates[0].followedAt, START);
  assert.equal(state.candidates[0].unfollowDueAt, "2026-08-15T01:00:00.000Z");
  assert.equal(state.run.inflightAction, undefined);
  assert.equal(state.history[0].status, "succeeded");
  assert.match(state.history[0].reason, /recovered/i);
});

test("keeps a manually pre-existing desired relationship skipped on a fresh intent", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [pendingFollow("alice")],
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    actionResults: [({ actionContext }) => ({
      status: "skipped",
      code: "already_desired",
      reason: "The Instagram profile is already followed.",
      intentId: actionContext.intentId,
      at: START,
    })],
  });

  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(harness.calls.performAction[0].actionContext.recoveringPersistedIntent, false);
  assert.equal(state.candidates[0].status, "skipped");
  assert.equal(state.candidates[0].followedAt, undefined);
  assert.equal(state.candidates[0].unfollowDueAt, undefined);
  assert.equal(state.history[0].status, "skipped");
});

test("records an already-unfollowed queued candidate as an unfollow success", async () => {
  const candidate = dueUnfollow("alice");
  candidate.status = "pending_unfollow";
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [candidate],
    activeBatch: { kind: "unfollow", candidateIds: ["instagram:alice"] },
    actionResults: [({ actionContext }) => ({
      status: "skipped",
      code: "already_desired",
      reason: "The Instagram profile is already unfollowed.",
      intentId: actionContext.intentId,
      at: START,
    })],
  });

  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(harness.calls.performAction[0].actionContext.recoveringPersistedIntent, false);
  assert.equal(state.candidates[0].status, "unfollowed");
  assert.equal(state.history[0].status, "succeeded");
  assert.match(state.history[0].reason, /already showed/i);
});

test("revisits a cap-truncated source after refill drops below threshold", async () => {
  const harness = createEngineHarness({
    sources: [
      source("source-a", { limit: 2 }),
      source("source-b", { limit: 2 }),
      source("source-c", { limit: 2 }),
    ],
    settings: {
      perSourceLimit: 2,
      backlogMaximum: 5,
      refillThreshold: 2,
      batchSize: 2,
    },
    collectResults: [
      { candidates: handles("a", 2), warning: null },
      { candidates: handles("b", 2), warning: null },
      { candidates: handles("c", 1), warning: null },
      { candidates: handles("c", 2), warning: null },
    ],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();
  let state = await harness.engine.getState();
  assert.deepEqual(harness.calls.collectFollowers.map(({ limit }) => limit), [2, 2, 1]);
  assert.equal(state.sources.find(({ id }) => id === "source-c").status, "pending");
  assert.equal(state.sources.find(({ id }) => id === "source-c").collectionDepth, 1);

  for (let wake = 0; wake < 10 && harness.calls.collectFollowers.length < 4; wake += 1) {
    harness.advanceToLastSchedule();
    await harness.engine.runDueWork();
  }

  state = await harness.engine.getState();
  assert.deepEqual(harness.calls.collectFollowers.map(({ limit }) => limit), [2, 2, 1, 2]);
  assert.equal(state.sources.find(({ id }) => id === "source-c").status, "completed");
  assert.equal(state.sources.find(({ id }) => id === "source-c").collectionDepth, 2);
  assert.equal(state.candidates.some(({ handle }) => handle === "c1"), true);
});

test("automatic refill chooses the eligible source collected least recently instead of list order", async () => {
  const harness = createEngineHarness({
    sources: [
      source("source-a", { lastCollectedAt: "2026-08-13T00:59:00.000Z", updatedAt: "2026-08-13T00:59:00.000Z" }),
      source("source-b", { lastCollectedAt: "2026-08-13T00:10:00.000Z", updatedAt: "2026-08-13T00:10:00.000Z" }),
      source("source-c", { createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" }),
    ],
    settings: { perSourceLimit: 2, backlogMaximum: 2, refillThreshold: 1, batchSize: 1 },
    collectResults: [{ candidates: handles("c", 2), warning: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  assert.deepEqual(harness.calls.collectFollowers.map(({ profileUrl }) => profileUrl), [
    "https://www.instagram.com/source.c/",
  ]);
});

test("an automatic source retry rotates behind a source that has waited longer", async () => {
  const harness = createEngineHarness({
    sources: [
      source("source-error", {
        status: "error",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:59:00.000Z",
      }),
      source("source-waiting", { updatedAt: "2026-08-13T00:10:00.000Z" }),
    ],
    settings: { perSourceLimit: 2, backlogMaximum: 2, refillThreshold: 1, batchSize: 1 },
    collectResults: [{ candidates: handles("waiting", 2), warning: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  assert.deepEqual(harness.calls.collectFollowers.map(({ profileUrl }) => profileUrl), [
    "https://www.instagram.com/source.waiting/",
  ]);
});

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

test("a completed-source rescan preserves known unfollowed candidates while admitting new followers", async () => {
  const known = dueUnfollow("known", ["source-a"]);
  known.status = "unfollowed";
  const harness = createEngineHarness({
    sources: [source("source-a", {
      status: "completed",
      lastCollectedAt: "2026-08-12T18:00:00.000Z",
      updatedAt: "2026-08-12T18:00:00.000Z",
    })],
    candidates: [known],
    settings: { sourceRescanHours: 6 },
    collectResults: [{ candidates: [{ handle: "known" }, { handle: "fresh" }], warning: null }],
    directOutcomes: [{ handle: "known", status: "succeeded", reason: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(harness.calls.collectAndFollowFollowers.length, 0);
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(state.candidates.find(({ handle }) => handle === "known").status, "unfollowed");
  assert.equal(state.candidates.find(({ handle }) => handle === "fresh").status, "pending_follow");
});

test("a failed completed-source rescan retries without direct modal follows", async () => {
  const known = dueUnfollow("known", ["source-a"]);
  known.status = "unfollowed";
  const harness = createEngineHarness({
    sources: [source("source-a", {
      status: "completed",
      lastCollectedAt: "2026-08-12T18:00:00.000Z",
      updatedAt: "2026-08-12T18:00:00.000Z",
    })],
    candidates: [known],
    settings: {
      sourceRescanHours: 6,
      batchDelayMinMinutes: 5,
      batchDelayMaxMinutes: 5,
    },
    collectResults: [
      new Error("Temporary collection failure."),
      { candidates: [{ handle: "known" }, { handle: "fresh" }], warning: null },
    ],
    directOutcomes: [{ handle: "known", status: "succeeded", reason: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();
  harness.advanceToLastSchedule();
  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(harness.calls.collectAndFollowFollowers.length, 0);
  assert.equal(harness.calls.collectFollowers.length, 2);
  assert.equal(state.candidates.find(({ handle }) => handle === "known").status, "unfollowed");
  assert.equal(state.candidates.find(({ handle }) => handle === "fresh").status, "pending_follow");
  assert.equal(state.sources[0].status, "completed");
});

test("an interrupted completed-source rescan recovers without direct modal follows", async () => {
  const known = dueUnfollow("known", ["source-a"]);
  known.status = "unfollowed";
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "collecting",
    sources: [source("source-a", {
      status: "collecting",
      lastCollectedAt: "2026-08-12T18:00:00.000Z",
      updatedAt: "2026-08-12T18:00:00.000Z",
    })],
    candidates: [known],
    collectResults: [{ candidates: [{ handle: "known" }, { handle: "fresh" }], warning: null }],
    directOutcomes: [{ handle: "known", status: "succeeded", reason: null }],
  });

  await harness.engine.reconcileStartup();
  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(harness.calls.collectAndFollowFollowers.length, 0);
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(state.candidates.find(({ handle }) => handle === "known").status, "unfollowed");
  assert.equal(state.candidates.find(({ handle }) => handle === "fresh").status, "pending_follow");
  assert.equal(state.sources[0].status, "completed");
});

test("a rescan reuses a legacy configured limit while capping backlog admission", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a", {
      limit: 5,
      status: "completed",
      collectionDepth: 1,
      lastCollectedAt: "2026-08-12T18:00:00.000Z",
      updatedAt: "2026-08-12T18:00:00.000Z",
    })],
    settings: {
      perSourceLimit: 2,
      backlogMaximum: 2,
      refillThreshold: 1,
      batchSize: 2,
      sourceRescanHours: 6,
    },
    collectResults: [{ candidates: handles("fresh", 5), processedCount: 5, warning: null }],
  });

  await harness.engine.startAuto();
  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(harness.calls.collectFollowers[0].limit, 5);
  assert.equal(state.candidates.length, 2);
  assert.equal(state.sources[0].status, "completed");
});

test("a future source rescan is not scheduled while the refill threshold is met", () => {
  const state = {
    version: 1,
    automationEnabled: true,
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS, refillThreshold: 1 },
    sources: [source("source-a", {
      status: "completed",
      lastCollectedAt: "2026-08-12T20:00:00.000Z",
      updatedAt: "2026-08-12T20:00:00.000Z",
    })],
    candidates: [pendingFollow("queued")],
    run: { phase: "idle", activeBatch: null },
    history: [],
  };

  assert.equal(followupEngine.nextSourceRescanDate(state, new Date(START)), null);
});

test("terminalizes an incomplete source after a deeper pass yields no novel candidates", async () => {
  const existing = [
    { ...pendingFollow("seen0"), status: "followed", unfollowDueAt: "2026-08-20T01:00:00.000Z" },
    { ...pendingFollow("seen1"), status: "followed", unfollowDueAt: "2026-08-21T01:00:00.000Z" },
  ];
  const harness = createEngineHarness({
    automationEnabled: true,
    sources: [source("source-a", { limit: 2, status: "pending", collectionDepth: 1 })],
    candidates: existing,
    settings: {
      perSourceLimit: 2,
      backlogMaximum: 5,
      refillThreshold: 2,
      batchSize: 2,
    },
    collectResults: [{ candidates: [{ handle: "seen0" }, { handle: "seen1" }], warning: null }],
  });

  await harness.engine.runDueWork();
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(state.sources[0].status, "completed");
  assert.equal(state.sources[0].collectionDepth, 2);
  assert.equal(state.candidates.length, 2);
});

test("persists complete immutable terminal history snapshots in raw storage", async () => {
  const initialState = {
    version: 1,
    automationEnabled: true,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [],
    candidates: [pendingFollow("alice", ["source-a", "source-b"])],
    run: {
      phase: "running_batch",
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    },
    history: [],
  };
  const storage = memoryStorage(initialState);
  const store = createFollowupStore({ storage, now: () => new Date(START) });
  const engine = createFollowupEngine({
    store,
    collectFollowers: async () => ({ candidates: [], warning: null }),
    collectOwnFollowerHandles: async () => ({ handles: [], warning: null }),
    performAction: async () => ({ status: "skipped", reason: "Already followed." }),
    schedule: async () => {},
    clearSchedule: async () => {},
    now: () => new Date(START),
    random: () => 0,
  });

  await engine.runDueWork();

  assert.deepEqual(storage.data.instagramFollowupState.history[0], {
    candidateId: "instagram:alice",
    action: "follow",
    kind: "follow",
    handle: "alice",
    sourceIds: ["source-a", "source-b"],
    status: "skipped",
    reason: "Already followed.",
    timestamp: START,
    at: START,
  });
  storage.data.instagramFollowupState.candidates[0].handle = "renamed";
  assert.equal(storage.data.instagramFollowupState.history[0].handle, "alice");
});

test("schedules the earliest future unfollow when automation is otherwise idle", async () => {
  const future = {
    ...dueUnfollow("future"),
    unfollowDueAt: "2026-08-14T01:00:00.000Z",
  };
  const later = {
    ...dueUnfollow("later"),
    unfollowDueAt: "2026-08-15T01:00:00.000Z",
  };
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [later, future],
  });

  await harness.engine.runDueWork();

  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), future.unfollowDueAt);
  assert.equal(harness.rawState().run.nextWorkAt, future.unfollowDueAt);
});

test("starts a due unfollow before collecting any source when no batch is active", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [dueUnfollow("due")],
    sources: [source("source-a")],
    collectResults: [{ candidates: handles("new", 200), warning: null }],
  });

  await harness.engine.runDueWork();

  assert.equal(harness.calls.performAction[0].action, "unfollow");
  assert.equal(harness.calls.collectFollowers.length, 0);
});

test("manual collection replaces a stale idle unfollow deadline with prompt work", async () => {
  const futureUnfollow = {
    ...dueUnfollow("future"),
    unfollowDueAt: "2026-08-14T01:00:00.000Z",
  };
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "idle",
    nextWorkAt: futureUnfollow.unfollowDueAt,
    sources: [source("source-a")],
    candidates: [futureUnfollow],
    collectResults: [{ candidates: [{ handle: "new.follow" }], warning: null }],
  });

  await harness.engine.runManualSource("source-a");

  assert.equal(harness.rawState().run.nextWorkAt, START);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), START);
  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction[0].expectedHandle, "new.follow");
  assert.equal(harness.calls.performAction[0].action, "follow");
});

test("manual collection wakes stale idle work but due unfollows retain action priority", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "idle",
    nextWorkAt: "2026-08-14T01:00:00.000Z",
    sources: [source("source-a")],
    candidates: [dueUnfollow("due")],
    collectResults: [{ candidates: [{ handle: "new.follow" }], warning: null }],
  });

  await harness.engine.runManualSource("source-a");
  await harness.engine.runDueWork();

  assert.equal(harness.calls.performAction[0].expectedHandle, "due");
  assert.equal(harness.calls.performAction[0].action, "unfollow");
});

test("legacy manual source requests wait behind an active batch safety deadline", async () => {
  const safetyDeadlineAt = "2026-08-13T01:00:10.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "waiting",
    nextWorkAt: safetyDeadlineAt,
    safetyDeadlineAt,
    activeBatch: { kind: "follow", candidateIds: ["instagram:queued"] },
    candidates: [pendingFollow("queued")],
    sources: [source("source-a", { status: "completed" })],
    collectResults: [{ candidates: [{ handle: "new.follow" }], warning: null }],
  });

  await harness.engine.runManualSource("source-a");

  const state = harness.rawState();
  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal(harness.calls.collectAndFollowFollowers.length, 0);
  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(state.run.sourceScanSourceId, "source-a");
  assert.equal(state.run.nextSourceScanAt, START);
  assert.equal(state.run.nextWorkAt, safetyDeadlineAt);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), safetyDeadlineAt);
});

test("removing a source preserves candidate and history provenance", async () => {
  const historical = {
    candidateId: "instagram:alice",
    action: "follow",
    kind: "follow",
    handle: "alice",
    sourceIds: ["source-a", "source-b"],
    status: "succeeded",
    reason: null,
    timestamp: START,
    at: START,
  };
  const harness = createEngineHarness({
    sources: [source("source-a"), source("source-b")],
    candidates: [pendingFollow("alice", ["source-a", "source-b"])],
    history: [historical],
  });

  await harness.engine.removeSource("source-a");

  const state = await harness.engine.getState();
  assert.deepEqual(state.sources.map(({ id }) => id), ["source-b"]);
  assert.equal(state.candidates.length, 1);
  assert.deepEqual(state.candidates[0].sourceIds, ["source-a", "source-b"]);
  assert.deepEqual(state.history[0].sourceIds, ["source-a", "source-b"]);
});

test("an action after source removal records every source that found the candidate", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    sources: [source("source-a"), source("source-b")],
    candidates: [pendingFollow("alice", ["source-a", "source-b"])],
  });

  await harness.engine.removeSource("source-a");
  await harness.engine.runDueWork();

  const state = await harness.engine.getState();
  assert.deepEqual(state.sources.map(({ id }) => id), ["source-b"]);
  assert.deepEqual(state.candidates[0].sourceIds, ["source-a", "source-b"]);
  assert.deepEqual(state.history[0].sourceIds, ["source-a", "source-b"]);
});

test("the global lane reviews due follow-backs before scanning sources", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    sources: [source("source-a")],
    candidates: [followed("alice")],
    relationshipResults: [{ handles: [], warning: null }],
  });

  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectOwnFollowerHandles.length, 1);
  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal(harness.calls.performAction.length, 0);
  assert.equal(harness.rawState().candidates[0].lastFollowBackCheckAt, START);
});

test("Start Auto persists canonical source and relationship deadlines before returning", async () => {
  const relationshipAt = "2026-08-14T01:00:00.000Z";
  const harness = createEngineHarness({
    sources: [source("source-a")],
    candidates: [followed("alice", {
      followBackReviewDueAt: relationshipAt,
      unfollowDueAt: relationshipAt,
    })],
  });

  await harness.engine.startAuto();

  const state = harness.rawState();
  assert.equal(state.run.nextSourceScanAt, START);
  assert.equal(state.run.nextRelationshipReviewAt, relationshipAt);
  assert.equal(state.run.nextWorkAt, START);
});

test("a complete absent follow-back review preserves J+2 then queues the unfollow", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [followed("alice")],
    relationshipResults: [{ handles: [], warning: null }],
  });

  await harness.engine.runDueWork();
  let state = harness.rawState();
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.candidates[0].unfollowDueAt, START);
  assert.equal(state.run.nextWorkAt, START);

  await harness.engine.runDueWork();
  state = harness.rawState();
  assert.equal(harness.calls.performAction[0].action, "unfollow");
  assert.equal(state.candidates[0].status, "unfollowed");
});

test("a confirmed follow-back is eligible in the same completed review", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [followed("alice")],
    relationshipResults: [{ handles: ["Alice"], warning: null }],
  });

  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(state.candidates[0].followBackStatus, "confirmed");
  assert.equal(state.candidates[0].followBackAt, START);
  assert.equal(state.candidates[0].status, "followed");
  assert.equal(state.candidates[0].unfollowDueAt, START);
  assert.equal(state.run.nextWorkAt, START);
  assert.equal(harness.calls.performAction.length, 0);
});

test("an incomplete follow-back review keeps every candidate unknown and retries safely", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [followed("alice"), followed("bob")],
    relationshipResults: [{ handles: ["alice"], warning: "Only a preview was available." }],
  });

  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.deepEqual(state.candidates.map(({ followBackStatus }) => followBackStatus), ["unknown", "unknown"]);
  assert.deepEqual(state.candidates.map(({ lastFollowBackCheckAt }) => lastFollowBackCheckAt), [undefined, undefined]);
  assert.equal(state.run.nextRelationshipReviewAt, "2026-08-13T01:05:00.000Z");
  assert.equal(state.run.nextWorkAt, "2026-08-13T01:05:00.000Z");
  assert.equal(harness.calls.performAction.length, 0);
});

test("a failed follow-back review remains unknown and uses the same retry cadence", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [followed("alice")],
    relationshipResults: [new Error("Followers dialog unavailable")],
  });

  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(state.candidates[0].followBackStatus, "unknown");
  assert.equal(state.candidates[0].lastFollowBackCheckAt, undefined);
  assert.equal(state.run.nextRelationshipReviewAt, "2026-08-13T01:05:00.000Z");
  assert.equal(harness.calls.performAction.length, 0);
});

test("due unfollows stay ahead of a simultaneous final review", async () => {
  const harness = createEngineHarness({
    automationEnabled: true,
    candidates: [dueUnfollow("due"), followed("review")],
  });

  await harness.engine.runDueWork();

  assert.equal(harness.calls.performAction[0].expectedHandle, "due");
  assert.equal(harness.calls.collectOwnFollowerHandles.length, 0);
});

test("scanNow queues the source behind an active action safety deadline", async () => {
  const deadline = "2026-08-13T01:00:10.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    phase: "waiting",
    activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    candidates: [pendingFollow("alice")],
    sources: [source("source-a", { status: "completed" })],
    nextWorkAt: deadline,
    safetyDeadlineAt: deadline,
  });

  await harness.engine.scanNow("source-a");

  let state = harness.rawState();
  assert.equal(state.sources[0].status, "pending");
  assert.equal(state.run.nextSourceScanAt, START);
  assert.equal(state.run.nextWorkAt, deadline);
  assert.equal(harness.calls.collectFollowers.length, 0);
  assert.equal(harness.calls.performAction.length, 0);

  await harness.engine.runDueWork();
  assert.equal(harness.calls.performAction.length, 0);
  harness.setNow(deadline);
  await harness.engine.runDueWork();
  state = harness.rawState();
  assert.equal(harness.calls.performAction.length, 1);
  assert.equal(state.run.nextSourceScanAt, START);
});

test("scanNow uses the global lane while automation is disabled", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a", { status: "completed" })],
    collectResults: [{ candidates: [{ handle: "new.follow" }], warning: null }],
  });

  await harness.engine.scanNow("source-a");
  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(state.automationEnabled, false);
  assert.equal(state.run.nextSourceScanAt, undefined);
  assert.equal(state.candidates[0].handle, "new.follow");
});

test("scanNow targets the requested source even above the automatic refill threshold", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a"), source("source-b", { status: "completed" })],
    candidates: handles("queued", 100).map(({ handle }) => pendingFollow(handle)),
    collectResults: [{ candidates: [], warning: null }],
  });

  await harness.engine.scanNow("source-b");
  await harness.engine.runDueWork();

  assert.equal(harness.calls.collectFollowers.length, 1);
  assert.equal(harness.calls.collectFollowers[0].profileUrl, "https://www.instagram.com/source.b/");
});

test("Stop cancels an automatic source deadline so a late alarm cannot collect or follow", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a")],
    directOutcomes: [{ handle: "alice", status: "succeeded" }],
  });

  await harness.engine.startAuto();
  await harness.engine.stop();
  await harness.engine.runDueWork();

  const state = harness.rawState();
  assert.equal(state.run.nextSourceScanAt, undefined);
  assert.equal(state.run.sourceScanSourceId, undefined);
  assert.equal(harness.calls.collectAndFollowFollowers.length, 0);
});

test("startup reconciliation reschedules an explicit disabled Scan Now request", async () => {
  const harness = createEngineHarness({
    sources: [source("source-a", { status: "completed" })],
  });

  await harness.engine.scanNow("source-a");
  harness.calls.schedule.length = 0;
  await harness.engine.reconcileStartup();

  assert.equal(harness.calls.clearSchedule, 0);
  assert.equal(harness.calls.schedule.length, 1);
  assert.equal(harness.calls.schedule[0].at.toISOString(), START);
  assert.equal(harness.rawState().run.sourceScanSourceId, "source-a");
});

test("scanNow persists its request while a foreign lease defers execution", async () => {
  const leaseExpiry = "2026-08-13T01:15:00.000Z";
  const harness = createEngineHarness({
    sources: [source("source-a", { status: "completed" })],
    lease: { ownerId: "other-worker", expiresAt: leaseExpiry },
  });

  await harness.engine.scanNow("source-a");

  const state = harness.rawState();
  assert.equal(state.sources[0].status, "pending");
  assert.equal(state.run.nextSourceScanAt, START);
  assert.equal(state.run.sourceScanSourceId, "source-a");
  assert.equal(state.run.nextWorkAt, leaseExpiry);
  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), leaseExpiry);
});

test("a Scan Now queued while paused resumes promptly instead of inheriting lifecycle work", async () => {
  const relationshipAt = "2026-08-20T01:00:00.000Z";
  const harness = createEngineHarness({
    automationEnabled: true,
    sources: [source("source-a", { status: "completed" })],
    candidates: [followed("alice", {
      followBackStatus: "confirmed",
      followBackAt: START,
      unfollowDueAt: relationshipAt,
    })],
    nextWorkAt: relationshipAt,
  });

  await harness.engine.pause();
  await harness.engine.scanNow("source-a");
  assert.equal(harness.rawState().run.nextWorkAt, START);
  await harness.engine.resume();

  assert.equal(harness.calls.schedule.at(-1).at.toISOString(), START);
});

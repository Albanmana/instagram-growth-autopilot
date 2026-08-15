import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as background from "../extension/background.js";
import {
  INSTAGRAM_FOLLOWUP_NEXT_WORK,
  createChromeTabGateway,
  createInstagramRelationshipGateway,
  installFollowupBackground,
} from "../extension/background.js";

test("local runtime composes direct modal collection separately from the profile action gateway", () => {
  assert.equal(typeof background.composeLocalRuntime, "function");
  const directCollector = async () => ({ processedCount: 0, warning: null });
  const staticCollector = async () => ({ candidates: [], warning: null });
  const ownFollowerCollector = async () => ({ handles: [], warning: null });
  let engineDependencies;
  const chromeApi = {
    storage: { local: {} },
    tabs: {},
    scripting: {},
    alarms: { create() {}, clear() {} },
  };

  background.composeLocalRuntime(chromeApi, () => {}, {
    createStore: () => ({ marker: "store" }),
    createTabs: () => ({ marker: "tabs" }),
    createFollowers: () => ({
      collectFollowers: staticCollector,
      collectAndFollowFollowers: directCollector,
      collectOwnFollowerHandles: ownFollowerCollector,
    }),
    createRelationshipGateway: () => async () => ({ status: "succeeded" }),
    createEngine: (dependencies) => {
      engineDependencies = dependencies;
      return { marker: "engine" };
    },
  });

  assert.equal(engineDependencies.collectFollowers, staticCollector);
  assert.equal(engineDependencies.collectAndFollowFollowers, directCollector);
  assert.equal(engineDependencies.collectOwnFollowerHandles, ownFollowerCollector);
  assert.notEqual(engineDependencies.collectAndFollowFollowers, engineDependencies.performAction);
});

function eventHarness() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    async emit(value) {
      for (const listener of listeners) await listener(value);
    },
    listeners,
  };
}

function installBackgroundHarness() {
  const onMessage = eventHarness();
  const onAlarm = eventHarness();
  const onStartup = eventHarness();
  const onInstalled = eventHarness();
  const calls = {
    addSource: [],
    removeSource: [],
    runManualSource: [],
    scanNow: [],
    startLiveTest: [],
    saveSettings: [],
    sidePanel: [],
    reconcileStartup: [],
    alarmGets: [],
    alarmCreates: [],
  };
  let state = {
    version: 1,
    automationEnabled: false,
    settings: { batchSize: 50, unfollowDelayDays: 2 },
    sources: [],
    candidates: [],
    run: { phase: "idle", activeBatch: null },
    history: [],
  };
  const engine = {
    getStateCalls: 0,
    startAutoCalls: 0,
    pauseCalls: 0,
    resumeCalls: 0,
    stopCalls: 0,
    runNextCycleNowCalls: 0,
    runDueWorkCalls: 0,
    reconcileStartupCalls: 0,
    async getState() {
      this.getStateCalls += 1;
      return structuredClone(state);
    },
    async addSource(input, limit) {
      calls.addSource.push({ input, limit });
      const added = { id: "instagram-source:alice", profileUrl: "https://www.instagram.com/alice/" };
      if (!state.sources.some(({ id }) => id === added.id)) state.sources.push(added);
      return structuredClone(added);
    },
    async runManualSource(sourceId) {
      calls.runManualSource.push(sourceId);
      return structuredClone(state);
    },
    async scanNow(sourceId) {
      calls.scanNow.push(sourceId);
      return structuredClone(state);
    },
    async startLiveTest(sourceId, limit) {
      calls.startLiveTest.push({ sourceId, limit });
      state.automationEnabled = true;
      state.run = {
        phase: "idle",
        activeBatch: null,
        liveTestSourceId: sourceId,
        liveTestCandidateIds: [],
      };
      return structuredClone(state);
    },
    async stopLiveTest() {
      this.stopCalls += 1;
      state.automationEnabled = false;
      state.run = { phase: "stopped", activeBatch: null };
      return structuredClone(state);
    },
    async removeSource(sourceId) {
      calls.removeSource.push(sourceId);
      state.sources = state.sources.filter(({ id }) => id !== sourceId);
      return structuredClone(state);
    },
    async startAuto() {
      this.startAutoCalls += 1;
      state.automationEnabled = true;
      state.run.phase = state.run.activeBatch ? "running_batch" : "idle";
      return structuredClone(state);
    },
    async pause() {
      this.pauseCalls += 1;
      state.run.phase = "paused";
      return structuredClone(state);
    },
    async resume() {
      this.resumeCalls += 1;
      state.automationEnabled = true;
      state.run.phase = state.run.activeBatch ? "running_batch" : "idle";
      return structuredClone(state);
    },
    async stop() {
      this.stopCalls += 1;
      state.automationEnabled = false;
      state.run.phase = "stopped";
      return structuredClone(state);
    },
    async runNextCycleNow() {
      this.runNextCycleNowCalls += 1;
      return structuredClone(state);
    },
    async runDueWork() {
      this.runDueWorkCalls += 1;
    },
    async reconcileStartup(options) {
      this.reconcileStartupCalls += 1;
      calls.reconcileStartup.push(structuredClone(options));
    },
    async saveSettings(settings) {
      calls.saveSettings.push(structuredClone(settings));
      state.settings = { ...state.settings, ...settings };
      return structuredClone(state);
    },
  };
  const store = {
    resetCalls: 0,
    async update(mutator) {
      const updated = mutator(structuredClone(state));
      calls.update.push(updated);
      return updated;
    },
    async exportJson() {
      return "{\"version\":1}";
    },
    async importJson(json) {
      calls.importJson = json;
      state = { ...state, ...JSON.parse(json) };
      return structuredClone(state);
    },
    async reset() {
      this.resetCalls += 1;
      state = {
        ...state,
        automationEnabled: false,
        sources: [],
        candidates: [],
        run: { phase: "idle", activeBatch: null },
        history: [],
      };
      return structuredClone(state);
    },
  };
  const chromeApi = {
    storage: {
      local: {
        values: {},
        async get(keys) { return Object.fromEntries(keys.map((key) => [key, this.values[key]])); },
        async set(values) { Object.assign(this.values, values); },
      },
    },
    runtime: { onMessage, onStartup, onInstalled },
    alarms: {
      onAlarm,
      async get(name) {
        calls.alarmGets.push(name);
        return undefined;
      },
      async create(name, details) {
        calls.alarmCreates.push({ name, details: structuredClone(details) });
      },
    },
    sidePanel: {
      async setPanelBehavior(options) {
        calls.sidePanel.push(structuredClone(options));
      },
    },
  };

  installFollowupBackground({ chromeApi, engine, store, logError: () => {} });

  return {
    calls,
    engine,
    store,
    alarms: onAlarm,
    startup: onStartup,
    installed: onInstalled,
    runtime: {
      async send(message) {
        assert.equal(onMessage.listeners.length, 1);
        return new Promise((resolve) => {
          const handled = onMessage.listeners[0](message, {}, resolve);
          if (handled !== true) resolve(undefined);
        });
      },
    },
  };
}

test("Start Auto delegates to the local engine and never invokes fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Background must not fetch.");
  };

  try {
    const { runtime, engine } = installBackgroundHarness();
    const persisted = await engine.getState();
    persisted.automationEnabled = true;
    persisted.run = {
      phase: "running_batch",
      activeBatch: { kind: "follow", candidateIds: ["instagram:alice"] },
    };
    engine.startAuto = async () => {
      engine.startAutoCalls += 1;
      return undefined;
    };
    engine.getState = async () => structuredClone(persisted);
    const response = await runtime.send({ type: "START_AUTO" });
    assert.deepEqual(response, { ok: true, state: persisted });
    assert.equal(engine.startAutoCalls, 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service-worker installation makes the toolbar action open the side panel", async () => {
  const { calls } = installBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.sidePanel, [{ openPanelOnActionClick: true }]);
});

test("only service-worker activation requests interrupted-operation recovery classification", async () => {
  const { calls, engine, startup, installed } = installBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.reconcileStartupCalls, 1);
  assert.deepEqual(calls.reconcileStartup, [{ serviceWorkerActivated: true }]);

  await startup.emit();
  assert.equal(engine.reconcileStartupCalls, 2);
  assert.equal(calls.reconcileStartup[1], undefined);

  await installed.emit();
  assert.equal(engine.reconcileStartupCalls, 3);
  assert.equal(calls.reconcileStartup[2], undefined);
});

test("runtime exposes every local follow-up intent and no sender fallback", async () => {
  const { runtime, engine, store, calls } = installBackgroundHarness();

  const stateResponse = await runtime.send({ type: "GET_FOLLOWUP_STATE" });
  assert.equal(stateResponse.health.status, "healthy");
  delete stateResponse.health;
  assert.deepEqual(stateResponse, {
    ok: true,
    state: await engine.getState(),
    scheduler: { status: "idle", plannedAt: null, alarmAt: null },
  });
  assert.deepEqual(await runtime.send({
    type: "ADD_SOURCE",
    payload: { input: "@alice", limit: 17 },
  }), {
    ok: true,
    source: { id: "instagram-source:alice", profileUrl: "https://www.instagram.com/alice/" },
    state: await engine.getState(),
  });
  assert.deepEqual(await runtime.send({
    type: "RUN_MANUAL_SOURCE",
    payload: { input: "@alice", limit: 23 },
  }), {
    ok: true,
    source: { id: "instagram-source:alice", profileUrl: "https://www.instagram.com/alice/" },
    state: await engine.getState(),
  });
  assert.deepEqual(calls.addSource, [
    { input: "@alice", limit: 17 },
    { input: "@alice", limit: 23 },
  ]);
  assert.deepEqual(calls.runManualSource, ["instagram-source:alice"]);
  assert.deepEqual(await runtime.send({
    type: "SCAN_NOW",
    payload: { sourceId: "instagram-source:alice" },
  }), { ok: true, state: await engine.getState() });
  assert.deepEqual(calls.scanNow, ["instagram-source:alice"]);
  assert.deepEqual(await runtime.send({
    type: "REMOVE_SOURCE",
    payload: { sourceId: "instagram-source:alice" },
  }), { ok: true, state: await engine.getState() });
  assert.deepEqual(calls.removeSource, ["instagram-source:alice"]);

  assert.deepEqual(await runtime.send({ type: "PAUSE_AUTO" }), { ok: true, state: await engine.getState() });
  assert.deepEqual(await runtime.send({ type: "RESUME_AUTO" }), { ok: true, state: await engine.getState() });
  assert.deepEqual(await runtime.send({ type: "STOP_AUTO" }), { ok: true, state: await engine.getState() });
  assert.equal(engine.pauseCalls, 1);
  assert.equal(engine.resumeCalls, 1);
  assert.equal(engine.stopCalls, 1);

  assert.deepEqual(await runtime.send({ type: "RUN_NEXT_CYCLE_NOW" }), { ok: true, state: await engine.getState() });
  assert.equal(engine.runNextCycleNowCalls, 1);

  assert.deepEqual(await runtime.send({
    type: "SAVE_FOLLOWUP_SETTINGS",
    payload: { settings: { batchSize: 25, unfollowDelayDays: 3 } },
  }), { ok: true, state: await engine.getState() });
  assert.deepEqual(calls.saveSettings, [{ batchSize: 25, unfollowDelayDays: 3 }]);

  assert.deepEqual(await runtime.send({ type: "EXPORT_FOLLOWUP_STATE" }), {
    ok: true,
    json: "{\"version\":1}",
  });
  const imported = await runtime.send({
    type: "IMPORT_FOLLOWUP_STATE",
    payload: { json: "{\"version\":2,\"automationEnabled\":false}" },
  });
  assert.equal(calls.importJson, "{\"version\":2,\"automationEnabled\":false}");
  assert.equal(imported.ok, true);
  assert.equal(imported.state.version, 2);
  assert.equal(imported.scheduler.status, "idle");
  assert.equal(imported.health.status, "healthy");
  assert.equal(engine.reconcileStartupCalls, 2);
  assert.deepEqual(calls.reconcileStartup.at(-1), { serviceWorkerActivated: true });
  assert.deepEqual(await runtime.send({ type: "RESET_FOLLOWUP_STATE" }), {
    ok: true,
    state: await engine.getState(),
  });
  assert.equal(engine.stopCalls, 3);
  assert.equal(store.resetCalls, 1);

  assert.equal(await runtime.send({ type: "START_BATCH" }), undefined);
});

test("state inspection rearms a missing Chrome alarm from the persisted next-work deadline", async () => {
  const { runtime, engine, calls } = installBackgroundHarness();
  const dueAt = "2026-08-14T16:00:00.000Z";
  engine.getState = async () => ({
    version: 1,
    automationEnabled: true,
    settings: { batchSize: 50, unfollowDelayDays: 2 },
    sources: [],
    candidates: [],
    run: { phase: "waiting", activeBatch: null, nextWorkAt: dueAt, cycle: { dueAt, stage: "review" } },
    history: [],
  });

  const response = await runtime.send({ type: "GET_FOLLOWUP_STATE" });

  assert.deepEqual(calls.alarmCreates, [{
    name: INSTAGRAM_FOLLOWUP_NEXT_WORK,
    details: { when: Date.parse(dueAt) },
  }]);
  assert.deepEqual(response.scheduler, {
    status: "rearmed",
    plannedAt: dueAt,
    alarmAt: dueAt,
  });
});

test("settings validation failures are returned to the caller without direct persistence", async () => {
  const harness = installBackgroundHarness();
  harness.engine.saveSettings = async () => {
    throw new Error("Follow-up settings require a positive backlogMaximum.");
  };
  harness.store.update = async () => {
    assert.fail("the background must not write settings outside the engine");
  };

  assert.deepEqual(await harness.runtime.send({
    type: "SAVE_FOLLOWUP_SETTINGS",
    payload: { settings: { backlogMaximum: 0 } },
  }), {
    ok: false,
    error: "Follow-up settings require a positive backlogMaximum.",
  });

  harness.engine.saveSettings = async (settings) => {
    assert.equal(settings, null);
    throw new Error("Follow-up settings changes must be an object.");
  };
  assert.deepEqual(await harness.runtime.send({
    type: "SAVE_FOLLOWUP_SETTINGS",
    payload: { settings: null },
  }), {
    ok: false,
    error: "Follow-up settings changes must be an object.",
  });
});

test("manifest needs no tabs permission or legacy scrape content scripts", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../extension/manifest.json", import.meta.url),
    "utf8",
  ));

  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(Object.hasOwn(manifest, "content_scripts"), false);
  assert.deepEqual(manifest.host_permissions, ["https://www.instagram.com/*"]);
  assert.equal(manifest.permissions.includes("unlimitedStorage"), true);
});

test("only the local follow-up alarm delegates due work", async () => {
  const { alarms, engine } = installBackgroundHarness();

  await alarms.emit({ name: "COLD_DM_RESULT_REPORT_RETRY" });
  assert.equal(engine.runDueWorkCalls, 0);

  await alarms.emit({ name: INSTAGRAM_FOLLOWUP_NEXT_WORK });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.runDueWorkCalls, 1);
});

test("relationship gateway waits for the new profile document before injecting one action and closing the tab", async () => {
  const calls = { open: [], wait: [], execute: [], close: [] };
  const gateway = createInstagramRelationshipGateway({
    async openTabAndWait(url, active, options) {
      calls.open.push({ url, active, options });
      return { id: 42 };
    },
    async waitForProfile(tab) {
      calls.wait.push(tab);
    },
    async executeScript(options) {
      calls.execute.push(options);
      return [{ result: { status: "succeeded", at: "2026-08-13T10:00:00.000Z" } }];
    },
    async closeTab(tabId) {
      calls.close.push(tabId);
    },
  });

  const result = await gateway({
    expectedHandle: "Alice.Example",
    action: "follow",
    profileUrl: "https://attacker.example/not-used",
    actionContext: {
      intentId: "follow:instagram:alice.example:1",
      candidateId: "instagram:alice.example",
      expectedHandle: "Alice.Example",
      action: "follow",
      recoveringPersistedIntent: true,
    },
  });

  assert.deepEqual(result, { status: "succeeded", at: "2026-08-13T10:00:00.000Z" });
  assert.deepEqual(calls.open, [{
    url: "https://www.instagram.com/alice.example/",
    active: true,
    options: { waitForComplete: true },
  }]);
  assert.deepEqual(calls.wait, [{ id: 42 }]);
  assert.equal(calls.execute.length, 1);
  assert.deepEqual(calls.execute[0].target, { tabId: 42 });
  assert.equal(calls.execute[0].injectImmediately, true);
  assert.deepEqual(calls.execute[0].args, [{
    expectedHandle: "Alice.Example",
    action: "follow",
    actionContext: {
      intentId: "follow:instagram:alice.example:1",
      candidateId: "instagram:alice.example",
      expectedHandle: "Alice.Example",
      action: "follow",
      recoveringPersistedIntent: true,
    },
  }]);
  assert.deepEqual(calls.close, [42]);
});

test("relationship gateway opens the queued target profile for an unfollow", async () => {
  const opened = [];
  const gateway = createInstagramRelationshipGateway({
    async openTabAndWait(url) {
      opened.push(url);
      return { id: 7 };
    },
    async waitForProfile() {},
    async executeScript() {
      return [{ result: { status: "succeeded" } }];
    },
    async closeTab() {},
  });

  await gateway({ expectedHandle: "alice", action: "unfollow" });

  assert.deepEqual(opened, ["https://www.instagram.com/alice/"]);
});

test("relationship gateway does not require the authenticated handle to unfollow multiple targets", async () => {
  const opened = [];
  let handleReads = 0;
  const gateway = createInstagramRelationshipGateway({
    async getOwnHandle() {
      handleReads += 1;
      return "alban.automation";
    },
    async openTabAndWait(url) {
      opened.push(url);
      return { id: 8 };
    },
    async waitForProfile() {},
    async executeScript() {
      return [{ result: { status: "succeeded" } }];
    },
    async closeTab() {},
  });

  await gateway({ expectedHandle: "alice", action: "unfollow" });
  await gateway({ expectedHandle: "bob", action: "unfollow" });

  assert.equal(handleReads, 0);
  assert.deepEqual(opened, [
    "https://www.instagram.com/alice/",
    "https://www.instagram.com/bob/",
  ]);
});

test("relationship gateway closes the action tab when script injection fails", async () => {
  const closed = [];
  const gateway = createInstagramRelationshipGateway({
    ownHandle: "alban.automation",
    async openTabAndWait() {
      return { id: 73 };
    },
    async executeScript() {
      throw new Error("Instagram scripting unavailable");
    },
    async closeTab(tabId) {
      closed.push(tabId);
    },
  });

  await assert.rejects(
    gateway({ expectedHandle: "alice", action: "unfollow" }),
    /scripting unavailable/,
  );
  assert.deepEqual(closed, [73]);
});

test("Chrome tab gateway closes a newly opened tab when Instagram redirects to login", async () => {
  const closed = [];
  const onUpdated = eventHarness();
  onUpdated.removeListener = () => {};
  const onRemoved = eventHarness();
  onRemoved.removeListener = () => {};
  const gateway = createChromeTabGateway({
    tabs: {
      onUpdated,
      onRemoved,
      async create() {
        return {
          id: 91,
          status: "complete",
          url: "https://www.instagram.com/accounts/login/",
        };
      },
      async get() {
        return {
          id: 91,
          status: "complete",
          url: "https://www.instagram.com/accounts/login/",
        };
      },
      async remove(tabId) {
        closed.push(tabId);
      },
    },
    scripting: { executeScript() {} },
  });

  await assert.rejects(
    gateway.openTabAndWait("https://www.instagram.com/alice/", true),
    /session is unavailable/i,
  );
  assert.deepEqual(closed, [91]);
});

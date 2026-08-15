import assert from "node:assert/strict";
import test from "node:test";
import { createFollowupRemoteStore } from "../extension/followup-remote-store.js";

test("remote store retries a compare-and-swap conflict without losing the mutation", async () => {
  let revision = 1;
  let state = { version: 1, counter: 0 };
  let writes = 0;
  const store = createFollowupRemoteStore({
    async readEngineState() { return { revision, state: structuredClone(state) }; },
    async replaceEngineState(expected, next) {
      writes += 1;
      if (writes === 1) { revision += 1; state = { ...state, concurrent: true }; throw new Error("Follow-up state revision conflict."); }
      assert.equal(expected, revision);
      revision += 1; state = structuredClone(next); return { revision, state: structuredClone(state) };
    },
  });
  const result = await store.update((current) => ({ ...current, counter: current.counter + 1 }));
  assert.equal(result.counter, 1);
  assert.equal(result.concurrent, true);
  assert.equal(writes, 2);
});

test("remote store supports the same export and reset controls as the local store", async () => {
  let revision = 1;
  let state = {
    version: 1,
    automationEnabled: true,
    settings: { perSourceLimit: 200, backlogMaximum: 500, refillThreshold: 100, sourceRescanHours: 6, batchSize: 50, actionDelayMinSeconds: 10, actionDelayMaxSeconds: 20, batchDelayMinMinutes: 5, batchDelayMaxMinutes: 7, unfollowDelayDays: 2, followBackUnfollowDelayDays: 7 },
    sources: [{ id: "source-a", profileUrl: "https://www.instagram.com/alice/" }], candidates: [], run: { phase: "idle", activeBatch: null }, history: [],
  };
  const store = createFollowupRemoteStore({
    async readEngineState() { return { revision, state: structuredClone(state) }; },
    async replaceEngineState(expected, next) { assert.equal(expected, revision); revision += 1; state = structuredClone(next); return { revision, state: structuredClone(state) }; },
  });
  assert.match(await store.exportJson(), /https:\/\/www\.instagram\.com\/alice/);
  const reset = await store.reset();
  assert.equal(reset.automationEnabled, false);
  assert.deepEqual(reset.sources, []);
});

test("remote store supplies source rescan defaults to an existing settings snapshot", async () => {
  let revision = 1;
  let state = {
    version: 1,
    automationEnabled: false,
    settings: {
      perSourceLimit: 200,
      backlogMaximum: 500,
      refillThreshold: 100,
      batchSize: 50,
      actionDelayMinSeconds: 10,
      actionDelayMaxSeconds: 20,
      batchDelayMinMinutes: 5,
      batchDelayMaxMinutes: 7,
      unfollowDelayDays: 2,
      followBackUnfollowDelayDays: 7,
    },
    sources: [], candidates: [], run: { phase: "idle", activeBatch: null }, history: [],
  };
  const store = createFollowupRemoteStore({
    async readEngineState() { return { revision, state: structuredClone(state) }; },
    async replaceEngineState(expected, next) {
      assert.equal(expected, revision);
      revision += 1;
      state = structuredClone(next);
      return { revision, state: structuredClone(state) };
    },
  });

  assert.equal((await store.load()).settings.sourceRescanHours, 6);
  await store.update((current) => current);
  assert.equal(state.settings.sourceRescanHours, 6);
});

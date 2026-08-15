import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSTAGRAM_GROWTH_STATE_KEY,
  createFollowupStore,
} from "../extension/followup-store.js";

const fixedNow = () => new Date("2026-08-13T01:00:00.000Z");

function fakeStorage(calls = [], initialData = {}) {
  return {
    data: { ...initialData },
    async get(keys) {
      calls.push(keys);
      return Object.fromEntries(keys.map((key) => [key, this.data[key]]));
    },
    async set(values) {
      calls.push(["set", values]);
      Object.assign(this.data, values);
    },
    async clear() {
      calls.push(["clear"]);
      this.data = {};
    },
  };
}

test("migrates a version-1 local state into the version-2 growth key", async () => {
  const legacyState = {
    version: 1,
    automationEnabled: true,
    settings: { batchSize: 10 },
    sources: [],
    candidates: [],
    run: { phase: "idle", activeBatch: null },
    history: [],
  };
  const storage = fakeStorage([], { instagramFollowupState: legacyState });
  const store = createFollowupStore({ storage, now: fixedNow });

  const state = await store.load();

  assert.equal(state.version, 2);
  assert.equal(state.automationEnabled, true);
  assert.equal(state.settings.batchSize, 10);
  assert.deepEqual(storage.data[INSTAGRAM_GROWTH_STATE_KEY], state);
  assert.deepEqual(storage.data.instagramFollowupState, legacyState);
});

test("migrates a missing state to local defaults without reading Cold DM keys", async () => {
  const calls = [];
  const store = createFollowupStore({ storage: fakeStorage(calls), now: fixedNow });

  const state = await store.load();

  assert.deepEqual(state, {
    version: 2,
    automationEnabled: false,
    settings: {
      perSourceLimit: 200,
      backlogMaximum: 500,
      refillThreshold: 100,
      sourceRescanHours: 6,
      cycleIntervalHours: 4,
      batchSize: 50,
      activeFollowCap: 1000,
      actionDelayMinSeconds: 5,
      actionDelayMaxSeconds: 10,
      batchDelayMinMinutes: 5,
      batchDelayMaxMinutes: 7,
      unfollowDelayDays: 2,
      followBackUnfollowDelayDays: 7,
    },
    sources: [],
    candidates: [],
    run: { phase: "idle", activeBatch: null },
    history: [],
  });
  assert.deepEqual(calls, [["instagramGrowthAutopilotState", "instagramFollowupState"]]);
});

test("exports local state and reset replaces only it with a disabled empty state", async () => {
  const calls = [];
  const storage = fakeStorage(calls, { unrelatedSetting: "keep" });
  const store = createFollowupStore({ storage, now: fixedNow });

  const exported = JSON.parse(await store.exportJson());
  assert.equal(exported.version, 2);
  await store.reset();

  assert.equal((await store.load()).automationEnabled, false);
  assert.equal(storage.data.unrelatedSetting, "keep");
  assert.equal(calls.some((call) => call[0] === "clear"), false);
});

test("imports a version-1 JSON export into the canonical version-2 local state", async () => {
  const storage = fakeStorage([], { unrelatedSetting: "keep" });
  const store = createFollowupStore({ storage, now: fixedNow });

  const imported = await store.importJson(JSON.stringify({
    version: 1,
    automationEnabled: true,
    settings: { batchSize: 10 },
    sources: [],
    candidates: [],
    run: { phase: "idle", activeBatch: null },
    history: [],
  }));

  assert.equal(imported.version, 2);
  assert.equal(imported.automationEnabled, true);
  assert.equal(imported.settings.batchSize, 10);
  assert.deepEqual(storage.data[INSTAGRAM_GROWTH_STATE_KEY], imported);
  assert.equal(storage.data.unrelatedSetting, "keep");
});

test("rejects malformed import JSON without changing the stored state", async () => {
  const storage = fakeStorage([], { [INSTAGRAM_GROWTH_STATE_KEY]: { version: 2, automationEnabled: true } });
  const store = createFollowupStore({ storage, now: fixedNow });

  await assert.rejects(store.importJson("not json"), /valid JSON/i);

  assert.deepEqual(storage.data[INSTAGRAM_GROWTH_STATE_KEY], { version: 2, automationEnabled: true });
});

test("updates a pure synchronous state mutation with exactly one normalized write", async () => {
  const calls = [];
  const storage = fakeStorage(calls);
  const store = createFollowupStore({ storage, now: fixedNow });

  const updated = await store.update((state) => ({
    ...state,
    automationEnabled: true,
    settings: { ...state.settings, batchSize: 10 },
  }));

  assert.equal(updated.automationEnabled, true);
  assert.equal(updated.settings.batchSize, 10);
  assert.deepEqual(calls.filter((call) => call[0] === "set").length, 1);
  assert.deepEqual(storage.data.instagramGrowthAutopilotState, updated);
});

test("rejects asynchronous update mutators before persisting", async () => {
  const calls = [];
  const store = createFollowupStore({ storage: fakeStorage(calls), now: fixedNow });

  await assert.rejects(store.update(async (state) => state), /synchronous/i);

  assert.equal(calls.filter((call) => call[0] === "set").length, 0);
});

test("rejects a malformed active batch before writing it", async () => {
  const calls = [];
  const store = createFollowupStore({ storage: fakeStorage(calls), now: fixedNow });

  await assert.rejects(store.save({
    version: 1,
    automationEnabled: false,
    settings: { batchSize: 1 },
    sources: [],
    candidates: [],
    run: { phase: "running", activeBatch: { kind: "remove", candidateIds: [] } },
    history: [],
  }), /batch/i);

  assert.equal(calls.filter((call) => call[0] === "set").length, 0);
});

test("rejects an absent state passed to save without writing defaults", async () => {
  const calls = [];
  const store = createFollowupStore({ storage: fakeStorage(calls), now: fixedNow });

  await assert.rejects(store.save(undefined), /state/i);

  assert.equal(calls.filter((call) => call[0] === "set").length, 0);
});

test("rejects an absent update result without writing defaults", async () => {
  const calls = [];
  const store = createFollowupStore({ storage: fakeStorage(calls), now: fixedNow });

  await assert.rejects(store.update(() => undefined), /state/i);

  assert.equal(calls.filter((call) => call[0] === "set").length, 0);
});

test("normalizes and preserves persisted scheduling, in-flight action, and collection progress", async () => {
  const storage = fakeStorage([], {
    instagramFollowupState: {
      version: 1,
      automationEnabled: true,
      sources: [{
        id: "instagram-source:alice",
        profileUrl: "https://www.instagram.com/alice/",
        limit: 200,
        status: "pending",
        collectionDepth: 100,
      }],
      candidates: [],
      history: [],
      run: {
        phase: "recovery_required",
        activeBatch: null,
        nextWorkAt: "2026-08-13T01:05:00.000Z",
        nextSourceScanAt: "2026-08-13T02:00:00.000Z",
        sourceScanSourceId: "instagram-source:alice",
        nextRelationshipReviewAt: "2026-08-13T03:00:00.000Z",
        cycle: { dueAt: "2026-08-13T03:00:00.000Z", stage: "collect" },
        safetyDeadlineAt: "2026-08-13T01:05:00.000Z",
        inflightAction: {
          id: "follow:instagram:alice:2026-08-13T01:00:00.000Z",
          candidateId: "instagram:alice",
          action: "follow",
          startedAt: "2026-08-13T01:00:00.000Z",
        },
        externalOperation: {
          id: "action:engine-a:1",
          ownerId: "engine-a",
          kind: "action",
          startedAt: "2026-08-13T01:00:00.000Z",
        },
        lease: {
          ownerId: "engine-a",
          expiresAt: "2026-08-13T01:15:00.000Z",
        },
      },
    },
  });
  const store = createFollowupStore({ storage, now: fixedNow });

  const state = await store.load();

  assert.equal(state.run.phase, "recovery_required");
  assert.equal(state.run.nextWorkAt, "2026-08-13T01:05:00.000Z");
  assert.equal(state.run.nextSourceScanAt, "2026-08-13T02:00:00.000Z");
  assert.equal(state.run.sourceScanSourceId, "instagram-source:alice");
  assert.equal(state.run.nextRelationshipReviewAt, "2026-08-13T03:00:00.000Z");
  assert.deepEqual(state.run.cycle, { dueAt: "2026-08-13T03:00:00.000Z", stage: "collect" });
  assert.equal(state.run.safetyDeadlineAt, "2026-08-13T01:05:00.000Z");
  assert.deepEqual(state.run.inflightAction, {
    id: "follow:instagram:alice:2026-08-13T01:00:00.000Z",
    candidateId: "instagram:alice",
    action: "follow",
    startedAt: "2026-08-13T01:00:00.000Z",
  });
  assert.deepEqual(state.run.externalOperation, {
    id: "action:engine-a:1",
    ownerId: "engine-a",
    kind: "action",
    startedAt: "2026-08-13T01:00:00.000Z",
  });
  assert.equal(state.sources[0].collectionDepth, 100);
  assert.deepEqual(state.run.lease, {
    ownerId: "engine-a",
    expiresAt: "2026-08-13T01:15:00.000Z",
  });
});

test("rejects noncanonical global scheduling deadlines", async () => {
  const store = createFollowupStore({ storage: fakeStorage(), now: fixedNow });
  const state = await store.load();

  await assert.rejects(store.save({
    ...state,
    run: { ...state.run, nextSourceScanAt: "2026-08-13" },
  }), /nextSourceScanAt.*canonical/i);
  await assert.rejects(store.save({
    ...state,
    run: { ...state.run, nextRelationshipReviewAt: "not-a-date" },
  }), /nextRelationshipReviewAt.*canonical/i);
});

test("collapses legacy source aliases conservatively and remaps all provenance", async () => {
  const storage = fakeStorage([], {
    instagramFollowupState: {
      version: 1,
      automationEnabled: false,
      sources: [
        {
          id: "Legacy-Alice",
          profileUrl: "https://www.instagram.com/Alice/",
          limit: 25,
          status: "completed",
          createdAt: "2026-08-10T01:00:00.000Z",
          updatedAt: "2026-08-12T01:00:00.000Z",
          lastCollectedAt: "2026-08-12T00:30:00.000Z",
          warning: "Owner-only preview.",
        },
        {
          id: "instagram-source:ALICE",
          profileUrl: "https://instagram.com/alice/",
          limit: 900,
          status: "collecting",
          createdAt: "2026-08-11T01:00:00.000Z",
          updatedAt: "2026-08-13T00:45:00.000Z",
          lastCollectedAt: "2026-08-13T00:30:00.000Z",
          warning: "Retry after interruption.",
        },
      ],
      candidates: [{
        id: "instagram:bob",
        handle: "bob",
        profileUrl: "https://www.instagram.com/bob/",
        normalizedHandle: "bob",
        sourceIds: ["Legacy-Alice", "instagram-source:ALICE", "External-Source", "external-source"],
        status: "pending_follow",
        createdAt: "2026-08-13T00:50:00.000Z",
        updatedAt: "2026-08-13T00:50:00.000Z",
      }],
      history: [{
        candidateId: "instagram:bob",
        kind: "follow",
        sourceIds: ["Legacy-Alice", "instagram-source:alice"],
        status: "failed",
      }],
      run: { phase: "idle", activeBatch: null },
    },
  });
  const store = createFollowupStore({ storage, now: fixedNow });

  const state = await store.load();

  assert.equal(state.sources.length, 1);
  assert.deepEqual({ ...state.sources[0], warning: undefined }, {
    id: "instagram-source:alice",
    profileUrl: "https://www.instagram.com/alice/",
    limit: 500,
    status: "pending",
    createdAt: "2026-08-10T01:00:00.000Z",
    updatedAt: "2026-08-13T00:45:00.000Z",
    lastCollectedAt: "2026-08-13T00:30:00.000Z",
    warning: undefined,
  });
  assert.match(state.sources[0].warning, /Owner-only preview/);
  assert.match(state.sources[0].warning, /Retry after interruption/);
  assert.match(state.sources[0].warning, /interrupted/i);
  assert.deepEqual(state.candidates[0].sourceIds, ["instagram-source:alice", "external-source"]);
  assert.deepEqual(state.history[0].sourceIds, ["instagram-source:alice"]);
});

test("rejects new duplicate source identities instead of relying on migration", async () => {
  const calls = [];
  const store = createFollowupStore({ storage: fakeStorage(calls), now: fixedNow });

  await assert.rejects(store.save({
    version: 1,
    automationEnabled: false,
    sources: [
      { id: "one", profileUrl: "https://www.instagram.com/Alice/", status: "pending" },
      { id: "two", profileUrl: "https://instagram.com/alice/", status: "pending" },
    ],
    candidates: [],
    history: [],
    run: { phase: "idle", activeBatch: null },
  }), /source.*unique/i);

  assert.equal(calls.filter((call) => call[0] === "set").length, 0);
});

test("serializes updates from distinct store wrappers over the same storage backend", async () => {
  const storage = fakeStorage();
  const first = createFollowupStore({ storage, now: fixedNow });
  const second = createFollowupStore({ storage, now: fixedNow });

  await Promise.all([
    first.update((state) => ({ ...state, sources: [...state.sources, { id: "source-a" }] })),
    second.update((state) => ({ ...state, sources: [...state.sources, { id: "source-b" }] })),
  ]);

  assert.deepEqual((await first.load()).sources.map(({ id }) => id), ["source-a", "source-b"]);
});

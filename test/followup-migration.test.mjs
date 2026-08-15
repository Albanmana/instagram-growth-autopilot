import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollowupStore } from "../extension/followup-store.js";
import {
  GROWTH_MIGRATION_BACKUP_KEY,
  GROWTH_MIGRATION_RECEIPT_KEY,
  runGrowthMigration,
} from "../extension/followup-migration.js";

const NOW = "2026-08-15T09:00:00.000Z";

function storage(initialData = {}) {
  return {
    data: structuredClone(initialData),
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, structuredClone(this.data[key])]));
    },
    async set(values) {
      Object.assign(this.data, structuredClone(values));
    },
  };
}

function legacyState() {
  return {
    version: 1,
    automationEnabled: true,
    settings: { batchSize: 10 },
    sources: [{ id: "source-a", profileUrl: "https://www.instagram.com/alice/", status: "pending" }],
    candidates: [],
    run: { phase: "idle", activeBatch: null, nextWorkAt: "2026-08-15T10:00:00.000Z" },
    history: [],
  };
}

test("writes, reads back, and checksums a legacy snapshot before completing", async () => {
  const backend = storage();
  const store = createFollowupStore({ storage: backend, now: () => new Date(NOW) });

  const result = await runGrowthMigration({
    storage: backend,
    store,
    readLegacySnapshot: async () => legacyState(),
    now: () => new Date(NOW),
  });

  assert.equal(result.status, "completed");
  assert.equal(backend.data[GROWTH_MIGRATION_BACKUP_KEY].version, 2);
  assert.equal(backend.data[GROWTH_MIGRATION_RECEIPT_KEY].status, "completed");
  assert.equal(backend.data[GROWTH_MIGRATION_RECEIPT_KEY].sourceChecksum, backend.data[GROWTH_MIGRATION_RECEIPT_KEY].storedChecksum);
});

test("keeps an unavailable legacy migration blocked without overwriting the current state", async () => {
  const backend = storage();
  const store = createFollowupStore({ storage: backend, now: () => new Date(NOW) });
  await store.save({ ...legacyState(), automationEnabled: false });
  const original = await store.load();

  const result = await runGrowthMigration({
    storage: backend,
    store,
    readLegacySnapshot: async () => { throw new Error("Failed to fetch"); },
    now: () => new Date(NOW),
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(await store.load(), original);
  assert.equal(backend.data[GROWTH_MIGRATION_RECEIPT_KEY].status, "blocked");
});

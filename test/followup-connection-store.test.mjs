import assert from "node:assert/strict";
import test from "node:test";

import { createFollowupConnectionStore } from "../extension/followup-connection-store.js";

test("connection store persists only paired connection data and a non-authoritative display cache", async () => {
  const storage = {
    data: { unrelated: "keep" },
    async get(keys) { return Object.fromEntries(keys.map((key) => [key, this.data[key]])); },
    async set(values) { Object.assign(this.data, values); },
  };
  const store = createFollowupConnectionStore({ storage });
  await store.saveConnection({ baseUrl: "http://127.0.0.1:4317", pairingToken: "token", accountId: "account-1" });
  await store.saveCachedState({ run: { phase: "idle" } });

  assert.deepEqual(await store.loadConnection(), { baseUrl: "http://127.0.0.1:4317", pairingToken: "token", accountId: "account-1" });
  assert.deepEqual(await store.loadCachedState(), { run: { phase: "idle" } });
  assert.equal(storage.data.unrelated, "keep");
});

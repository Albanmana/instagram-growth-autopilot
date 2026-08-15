import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollowupHealth } from "../extension/followup-health.js";

const NOW = "2026-08-15T09:00:00.000Z";

function storage() {
  return {
    data: {},
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, structuredClone(this.data[key])]));
    },
    async set(values) {
      Object.assign(this.data, structuredClone(values));
    },
  };
}

function plus(milliseconds) {
  return new Date(Date.parse(NOW) + milliseconds).toISOString();
}

test("escalates recoverable failures through the durable retry schedule", async () => {
  const health = createFollowupHealth({ storage: storage(), now: () => new Date(NOW) });

  assert.equal((await health.recordFailure(new Error("Instagram tab was closed"))).nextRetryAt, plus(60_000));
  assert.equal((await health.recordFailure(new Error("Instagram tab was closed"))).nextRetryAt, plus(300_000));
  assert.equal((await health.recordFailure(new Error("Instagram tab was closed"))).nextRetryAt, plus(900_000));
});

test("notifies once when authentication becomes intervention-required", async () => {
  const notifications = [];
  const health = createFollowupHealth({
    storage: storage(),
    now: () => new Date(NOW),
    notify: async (payload) => notifications.push(payload),
  });

  await health.recordFailure(new Error("Instagram session is unavailable. Log in to Instagram in this browser and try again."));
  await health.recordFailure(new Error("Instagram session is unavailable. Log in to Instagram in this browser and try again."));

  assert.equal((await health.get()).status, "intervention_required");
  assert.equal(notifications.length, 1);
});

test("resets the retry streak after a successful operation", async () => {
  const health = createFollowupHealth({ storage: storage(), now: () => new Date(NOW) });
  await health.recordFailure(new Error("network unavailable"));

  const result = await health.recordSuccess();

  assert.equal(result.status, "healthy");
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(result.nextRetryAt, undefined);
});

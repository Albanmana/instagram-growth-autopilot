import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveAcceleratedTest, LIVE_TEST_SOURCE_LIMIT } from "../extension/live-accelerated-test.js";

function storageHarness() {
  let values = {};
  return {
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async set(next) { values = { ...values, ...structuredClone(next) }; },
  };
}

test("calendar dates map from seven virtual days per real minute while safety dates stay wall-clock", async () => {
  let realNow = Date.parse("2026-08-14T12:00:00.000Z");
  const liveTest = createLiveAcceleratedTest({ storage: storageHarness(), now: () => realNow });
  const session = await liveTest.start({ sourceId: "instagram-source:noevarner.ai" });
  assert.equal(LIVE_TEST_SOURCE_LIMIT, 10);
  assert.equal(liveTest.now().getTime(), session.virtualStartedAt);
  assert.equal(liveTest.toAlarmTime(new Date(session.virtualStartedAt + (7 * 86_400_000)), { safety: false }).getTime(), realNow + 60_000);
  assert.equal(liveTest.toAlarmTime(new Date(session.virtualStartedAt + 10_000), { safety: true }).getTime(), realNow + 10_000);
  realNow += 10_000;
  assert.equal(liveTest.now().getTime(), session.virtualStartedAt + (10_000 * 10_080));
});

test("expired sessions deactivate after a restart-safe load", async () => {
  let realNow = Date.parse("2026-08-14T12:00:00.000Z");
  const storage = storageHarness();
  const first = createLiveAcceleratedTest({ storage, now: () => realNow, durationMs: 1_000 });
  await first.start({ sourceId: "instagram-source:noevarner.ai" });
  realNow += 1_001;
  const restarted = createLiveAcceleratedTest({ storage, now: () => realNow, durationMs: 1_000 });
  assert.equal((await restarted.load()).active, false);
  assert.equal(restarted.now().getTime(), realNow);
});

test("the default live session remains active beyond the twenty-minute action window", async () => {
  let realNow = Date.parse("2026-08-14T12:00:00.000Z");
  const storage = storageHarness();
  const first = createLiveAcceleratedTest({ storage, now: () => realNow });
  await first.start({ sourceId: "instagram-source:noevarner.ai" });

  realNow += (20 * 60_000) + 1;
  const restarted = createLiveAcceleratedTest({ storage, now: () => realNow });

  assert.equal((await restarted.load()).active, true);
});

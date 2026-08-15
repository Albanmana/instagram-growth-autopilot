import assert from "node:assert/strict";
import test from "node:test";

import { createFollowupServiceClient } from "../extension/followup-service-client.js";

test("service client can provision a local account without an existing account id", async () => {
  const requests = [];
  const client = createFollowupServiceClient({
    baseUrl: "http://localhost:4317",
    pairingToken: "a-valid-local-pairing-token-value-123456",
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ ok: true, account: { accountId: "account-1", normalizedHandle: "alban", created: true } }), { status: 200 });
    },
  });
  assert.deepEqual(await client.provision("@Alban"), { accountId: "account-1", normalizedHandle: "alban", created: true });
  assert.match(requests[0].url, /127\.0\.0\.1:4317\/v1\/provision$/);
  assert.equal(requests[0].options.headers["X-Instagram-Account-Id"], undefined);
});

test("the bridge sends pairing auth only to loopback origins", () => {
  assert.throws(() => createFollowupServiceClient({
    fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    baseUrl: "https://example.com",
    pairingToken: "a-valid-local-pairing-token-value-123456",
    accountId: "account-1",
  }), /loopback/i);
});

test("the bridge sends the account and pairing token to a loopback service", async () => {
  let observed;
  const client = createFollowupServiceClient({
    fetch: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ ok: true, state: { run: { phase: "idle" } } }), { status: 200 });
    },
    baseUrl: "http://127.0.0.1:4317",
    pairingToken: "a-valid-local-pairing-token-value-123456",
    accountId: "account-1",
  });

  assert.deepEqual(await client.getState(), { run: { phase: "idle" } });
  assert.equal(observed.url, "http://127.0.0.1:4317/v1/state");
  assert.equal(observed.init.headers.Authorization, "Bearer a-valid-local-pairing-token-value-123456");
  assert.equal(observed.init.headers["X-Instagram-Account-Id"], "account-1");
});

test("the bridge reads the authenticated handle for an existing pairing", async () => {
  let observed;
  const client = createFollowupServiceClient({
    fetch: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ ok: true, account: { normalizedHandle: "alban.automation" } }), { status: 200 });
    },
    baseUrl: "http://127.0.0.1:4317",
    pairingToken: "a-valid-local-pairing-token-value-123456",
    accountId: "account-1",
  });

  assert.deepEqual(await client.getAccount(), { normalizedHandle: "alban.automation" });
  assert.equal(observed.url, "http://127.0.0.1:4317/v1/account");
  assert.equal(observed.init.headers["X-Instagram-Account-Id"], "account-1");
});

test("the bridge reads and conditionally writes the revisioned engine snapshot", async () => {
  const requests = [];
  const client = createFollowupServiceClient({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ ok: true, snapshot: { revision: 2, state: { version: 1 } } }), { status: 200 });
    }, baseUrl: "http://127.0.0.1:4317", pairingToken: "a-valid-local-pairing-token-value-123456", accountId: "account-1",
  });
  assert.deepEqual(await client.readEngineState(), { revision: 2, state: { version: 1 } });
  await client.replaceEngineState(2, { version: 1, sources: [] });
  assert.equal(requests[1].init.method, "PUT");
});

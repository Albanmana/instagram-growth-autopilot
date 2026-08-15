import assert from "node:assert/strict";
import test from "node:test";

import { createLocalService } from "../local-service/server.mjs";

function createControlPlane() {
  return {
    provision: async (handle) => ({ accountId: "account-1", normalizedHandle: handle, created: true }),
    getAccount: async () => ({ normalizedHandle: "alban.automation" }),
    getState: async () => ({ run: { phase: "idle" } }),
    command: async () => ({ run: { phase: "idle" } }),
    claim: async () => null,
    start: async () => ({ ok: true }),
    complete: async () => ({ ok: true }),
    importLegacyState: async () => ({ ok: true }),
    readEngineState: async () => ({ revision: 1, state: { version: 1 } }),
    replaceEngineState: async (_accountId, revision, state) => ({ revision: revision + 1, state }),
  };
}

test("service provisions a paired Instagram account before an account header exists", async (context) => {
  const service = createLocalService({ controlPlane: createControlPlane(), config: { host: "127.0.0.1", port: 0, pairingToken: "a-valid-local-pairing-token-value-123456" } });
  const address = await service.listen();
  context.after(() => service.close());

  const response = await request(address.port, "/v1/provision", {
    method: "POST",
    headers: { Authorization: "Bearer a-valid-local-pairing-token-value-123456", "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "@Alban.Test" }),
  });

  assert.deepEqual(await response.json(), { ok: true, account: { accountId: "account-1", normalizedHandle: "@Alban.Test", created: true } });
});

async function request(port, path, options = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

test("service rejects a request without the pairing bearer token", async (context) => {
  const service = createLocalService({
    controlPlane: createControlPlane(),
    config: { host: "127.0.0.1", port: 0, pairingToken: "a-valid-local-pairing-token-value-123456" },
  });
  const address = await service.listen();
  context.after(() => service.close());

  const response = await request(address.port, "/v1/state");

  assert.equal(response.status, 401);
});

test("service exposes a paired revisioned engine store", async (context) => {
  const service = createLocalService({ controlPlane: createControlPlane(), config: { host: "127.0.0.1", port: 0, pairingToken: "a-valid-local-pairing-token-value-123456" } });
  const address = await service.listen();
  context.after(() => service.close());
  const headers = { Authorization: "Bearer a-valid-local-pairing-token-value-123456", "X-Instagram-Account-Id": "account-1", "Content-Type": "application/json" };
  const get = await request(address.port, "/v1/engine-state", { headers });
  assert.deepEqual(await get.json(), { ok: true, snapshot: { revision: 1, state: { version: 1 } } });
  const put = await request(address.port, "/v1/engine-state", { method: "PUT", headers, body: JSON.stringify({ revision: 1, state: { version: 2 } }) });
  assert.deepEqual(await put.json(), { ok: true, snapshot: { revision: 2, state: { version: 2 } } });
});

test("service returns durable state through the paired loopback endpoint", async (context) => {
  const service = createLocalService({
    controlPlane: createControlPlane(),
    config: { host: "127.0.0.1", port: 0, pairingToken: "a-valid-local-pairing-token-value-123456" },
  });
  const address = await service.listen();
  context.after(() => service.close());

  const response = await request(address.port, "/v1/state", {
    headers: {
      Authorization: "Bearer a-valid-local-pairing-token-value-123456",
      "X-Instagram-Account-Id": "account-1",
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, state: { run: { phase: "idle" } } });
});

test("service returns the paired account handle to an existing extension connection", async (context) => {
  const service = createLocalService({
    controlPlane: createControlPlane(),
    config: { host: "127.0.0.1", port: 0, pairingToken: "a-valid-local-pairing-token-value-123456" },
  });
  const address = await service.listen();
  context.after(() => service.close());

  const response = await request(address.port, "/v1/account", {
    headers: {
      Authorization: "Bearer a-valid-local-pairing-token-value-123456",
      "X-Instagram-Account-Id": "account-1",
    },
  });

  assert.deepEqual(await response.json(), { ok: true, account: { normalizedHandle: "alban.automation" } });
});

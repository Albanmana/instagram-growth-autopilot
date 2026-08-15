import assert from "node:assert/strict";
import test from "node:test";

import { loadServiceConfig } from "../local-service/config.mjs";

const validEnvironment = {
  FOLLOWUP_SERVICE_HOST: "127.0.0.1",
  FOLLOWUP_SERVICE_PORT: "4317",
  FOLLOWUP_SUPABASE_URL: "http://127.0.0.1:54321",
  FOLLOWUP_SUPABASE_SERVICE_ROLE_KEY: "local-service-role-key",
  FOLLOWUP_PAIRING_TOKEN: "a-valid-local-pairing-token-value-123456",
};

test("local service only accepts loopback and a sufficiently random pairing token", () => {
  assert.throws(() => loadServiceConfig({ ...validEnvironment, FOLLOWUP_SERVICE_HOST: "0.0.0.0" }), /127\.0\.0\.1/);
  assert.throws(() => loadServiceConfig({ ...validEnvironment, FOLLOWUP_PAIRING_TOKEN: "short" }), /pairing token/i);
});

test("local service parses a valid loopback configuration without changing secrets", () => {
  assert.deepEqual(loadServiceConfig(validEnvironment), {
    host: "127.0.0.1",
    port: 4317,
    supabaseUrl: "http://127.0.0.1:54321",
    supabaseServiceRoleKey: "local-service-role-key",
    pairingToken: "a-valid-local-pairing-token-value-123456",
  });
});

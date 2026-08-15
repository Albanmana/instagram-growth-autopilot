import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlane } from "../local-service/domain.mjs";

function fakeRepository() {
  const commands = [];
  return {
    commands,
    async dispatchCommand(accountId, command) {
      commands.push({ accountId, command });
      return { automationEnabled: false, run: { phase: command.type === "STOP_AUTO" ? "stopped" : "paused" } };
    },
    async getSnapshot() { return { automationEnabled: false, run: { phase: "paused" } }; },
    async claimNextTask() { return null; },
    async startTask() { return { ok: true }; },
    async completeTask() { return { ok: true }; },
    async importLegacyState() { return { ok: true }; },
  };
}

test("paused automation never emits a task and stop delegates a durable control command", async () => {
  const repository = fakeRepository();
  const controlPlane = createControlPlane({ repository });

  await controlPlane.command("account-1", { type: "PAUSE_AUTO" });
  assert.equal(await controlPlane.claim("account-1", "extension:test"), null);
  await controlPlane.command("account-1", { type: "STOP_AUTO" });

  assert.deepEqual(repository.commands.map(({ command }) => command.type), ["PAUSE_AUTO", "STOP_AUTO"]);
});

test("control plane rejects unknown commands before persistence", async () => {
  const repository = fakeRepository();
  const controlPlane = createControlPlane({ repository });

  await assert.rejects(controlPlane.command("account-1", { type: "ERASE_EVERYTHING" }), /unsupported/i);
  assert.equal(repository.commands.length, 0);
});

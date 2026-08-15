import assert from "node:assert/strict";
import test from "node:test";

import { createFollowupRepository } from "../local-service/repository.mjs";

function fakeClient() {
  const calls = [];
  const task = {
    id: "task-1",
    kind: "follow",
    claim_token: "claim-a",
    payload: { candidateId: "candidate-1" },
  };
  let claimAvailable = true;
  return {
    calls,
    async rpc(name, payload) {
      calls.push({ name, payload });
      if (name === "followup_claim_next_task") {
        if (!claimAvailable) return { data: null, error: null };
        claimAvailable = false;
        return { data: task, error: null };
      }
      if (name === "followup_complete_task" && payload.p_claim_token !== "claim-a") {
        return { data: null, error: { message: "claim token does not match" } };
      }
      if (name === "followup_get_account") {
        return { data: { normalizedHandle: "alban.automation" }, error: null };
      }
      return { data: { ok: true }, error: null };
    },
  };
}

test("only one claimant receives the same due task", async () => {
  const client = fakeClient();
  const repository = createFollowupRepository(client);

  const [first, second] = await Promise.all([
    repository.claimNextTask("account-1", "extension:A"),
    repository.claimNextTask("account-1", "extension:B"),
  ]);

  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal([first, second].find(Boolean).claimToken, "claim-a");
  assert.equal(client.calls.filter(({ name }) => name === "followup_claim_next_task").length, 2);
});

test("a mismatched claim token cannot complete a task", async () => {
  const repository = createFollowupRepository(fakeClient());

  await assert.rejects(
    repository.completeTask("account-1", "task-1", "wrong", { status: "succeeded" }),
    /claim token does not match/,
  );
});

test("repository reads and conditionally replaces the durable engine state", async () => {
  const client = fakeClient();
  const repository = createFollowupRepository(client);
  await repository.replaceState("account-1", 4, { version: 1, sources: [] });
  assert.deepEqual(client.calls.at(-1), {
    name: "followup_compare_and_swap_state",
    payload: { p_account_id: "account-1", p_revision: 4, p_state: { version: 1, sources: [] } },
  });
});

test("repository reads only the normalized Instagram handle for a paired account", async () => {
  const client = fakeClient();
  const repository = createFollowupRepository(client);

  assert.deepEqual(await repository.getAccount("account-1"), { normalizedHandle: "alban.automation" });
  assert.deepEqual(client.calls.at(-1), {
    name: "followup_get_account",
    payload: { p_account_id: "account-1" },
  });
});

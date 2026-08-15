function errorFromResponse(error) {
  if (!error) return null;
  return new Error(error.message || String(error));
}

async function callRpc(client, name, payload) {
  const { data, error } = await client.rpc(name, payload);
  const failure = errorFromResponse(error);
  if (failure) throw failure;
  return data;
}

function taskFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload || {},
    claimToken: row.claim_token,
    expiresAt: row.expires_at,
  };
}

export function createFollowupRepository(client) {
  if (!client || typeof client.rpc !== "function") {
    throw new Error("Follow-up repository requires a Supabase RPC client.");
  }

  return {
    provisionAccount(handle) {
      return callRpc(client, "followup_provision_account", { p_handle: handle });
    },
    getAccount(accountId) {
      return callRpc(client, "followup_get_account", { p_account_id: accountId });
    },
    getSnapshot(accountId) {
      return callRpc(client, "followup_snapshot", { p_account_id: accountId });
    },
    readState(accountId) {
      return callRpc(client, "followup_read_state", { p_account_id: accountId });
    },
    replaceState(accountId, revision, state) {
      return callRpc(client, "followup_compare_and_swap_state", {
        p_account_id: accountId,
        p_revision: revision,
        p_state: state,
      });
    },
    dispatchCommand(accountId, command) {
      return callRpc(client, "followup_dispatch_command", {
        p_account_id: accountId,
        p_command: command,
      });
    },
    async claimNextTask(accountId, claimantId) {
      return taskFromRow(await callRpc(client, "followup_claim_next_task", {
        p_account_id: accountId,
        p_claim_owner: claimantId,
      }));
    },
    startTask(accountId, taskId, claimToken) {
      return callRpc(client, "followup_start_task", {
        p_account_id: accountId,
        p_task_id: taskId,
        p_claim_token: claimToken,
      });
    },
    completeTask(accountId, taskId, claimToken, outcome) {
      return callRpc(client, "followup_complete_task", {
        p_account_id: accountId,
        p_task_id: taskId,
        p_claim_token: claimToken,
        p_outcome: outcome,
      });
    },
    importLegacyState(accountId, legacyState, checksum) {
      return callRpc(client, "followup_import_legacy_state", {
        p_account_id: accountId,
        p_legacy_state: legacyState,
        p_checksum: checksum,
      });
    },
  };
}

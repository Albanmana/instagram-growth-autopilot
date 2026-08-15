const COMMAND_TYPES = new Set([
  "ADD_SOURCE",
  "REMOVE_SOURCE",
  "SCAN_NOW",
  "RUN_FOLLOW_BACK_REVIEW",
  "START_AUTO",
  "PAUSE_AUTO",
  "RESUME_AUTO",
  "STOP_AUTO",
  "SAVE_FOLLOWUP_SETTINGS",
  "EXPORT_FOLLOWUP_STATE",
  "RESET_FOLLOWUP_STATE",
]);

function requireAccountId(accountId) {
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("An Instagram account ID is required.");
  return accountId;
}

function requireHandle(handle) {
  if (typeof handle !== "string" || !handle.trim()) throw new Error("An Instagram handle is required.");
  return handle.trim();
}

function validateCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("A structured control-plane command is required.");
  }
  if (!COMMAND_TYPES.has(command.type)) throw new Error(`Unsupported follow-up command: ${command.type || "unknown"}.`);
  return { ...command };
}

export function createControlPlane({ repository }) {
  if (!repository || typeof repository.getSnapshot !== "function" || typeof repository.dispatchCommand !== "function") {
    throw new Error("Control plane requires a durable repository.");
  }

  return {
    provision(handle) {
      return repository.provisionAccount(requireHandle(handle));
    },
    getAccount(accountId) {
      return repository.getAccount(requireAccountId(accountId));
    },
    getState(accountId) {
      return repository.getSnapshot(requireAccountId(accountId));
    },
    readEngineState(accountId) {
      return repository.readState(requireAccountId(accountId));
    },
    replaceEngineState(accountId, revision, state) {
      return repository.replaceState(requireAccountId(accountId), revision, state);
    },
    async command(accountId, command) {
      return repository.dispatchCommand(requireAccountId(accountId), validateCommand(command));
    },
    claim(accountId, claimantId) {
      return repository.claimNextTask(requireAccountId(accountId), claimantId);
    },
    start(accountId, taskId, claimToken) {
      return repository.startTask(requireAccountId(accountId), taskId, claimToken);
    },
    complete(accountId, taskId, claimToken, outcome) {
      return repository.completeTask(requireAccountId(accountId), taskId, claimToken, outcome);
    },
    importLegacyState(accountId, state, checksum) {
      return repository.importLegacyState(requireAccountId(accountId), state, checksum);
    },
  };
}

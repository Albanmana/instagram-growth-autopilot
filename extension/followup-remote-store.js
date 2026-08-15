import { FOLLOWUP_STORE_SYNCHRONIZATION_KEY } from "./followup-store.js";
import { createEmptyFollowupState } from "./followup-store.js";
import { buildLocalExport, DEFAULT_FOLLOWUP_SETTINGS } from "./followup-model.js";

const MAX_CONFLICT_RETRIES = 3;

function normalizeLegacySettings(state) {
  if (!state?.settings || typeof state.settings !== "object" || Array.isArray(state.settings)
    || Object.keys(state.settings).length === 0) {
    return structuredClone(state);
  }
  return {
    ...state,
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS, ...state.settings },
  };
}

export function createFollowupRemoteStore(client) {
  if (!client || typeof client.readEngineState !== "function" || typeof client.replaceEngineState !== "function") {
    throw new Error("Remote follow-up store requires revisioned service methods.");
  }
  let queue = Promise.resolve();
  const exclusive = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => normalizeLegacySettings((await client.readEngineState()).state);
  const save = (next) => exclusive(async () => {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const snapshot = await client.readEngineState();
      try { return structuredClone((await client.replaceEngineState(snapshot.revision, next)).state); }
      catch (error) { if (!/revision conflict/i.test(String(error)) || attempt === MAX_CONFLICT_RETRIES - 1) throw error; }
    }
  });
  const update = (mutator) => exclusive(async () => {
    for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
      const snapshot = await client.readEngineState();
      const next = mutator(normalizeLegacySettings(snapshot.state));
      if (next && typeof next.then === "function") throw new Error("Follow-up update mutator must be synchronous.");
      try { return structuredClone((await client.replaceEngineState(snapshot.revision, next)).state); }
      catch (error) { if (!/revision conflict/i.test(String(error)) || attempt === MAX_CONFLICT_RETRIES - 1) throw error; }
    }
  });
  async function exportJson() {
    return JSON.stringify(buildLocalExport(await load()));
  }
  function reset() {
    return save(createEmptyFollowupState());
  }
  return { load, save, update, exportJson, reset, [FOLLOWUP_STORE_SYNCHRONIZATION_KEY]: client };
}

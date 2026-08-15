import {
  DEFAULT_FOLLOWUP_SETTINGS,
  buildLocalExport,
  normalizeSourceId,
  normalizeSourceInput,
  sourceIdFromProfileUrl,
} from "./followup-model.js";

export const INSTAGRAM_GROWTH_STATE_KEY = "instagramGrowthAutopilotState";
export const LEGACY_INSTAGRAM_FOLLOWUP_STATE_KEY = "instagramFollowupState";
// Keep the previous export name as a compatibility alias for extension modules.
export const INSTAGRAM_FOLLOWUP_STATE_KEY = INSTAGRAM_GROWTH_STATE_KEY;
export const FOLLOWUP_STORE_SYNCHRONIZATION_KEY = Symbol("followupStoreSynchronizationKey");

const STORAGE_OPERATION_QUEUES = new WeakMap();
const PRIVATE_FOLLOW_REQUEST_GATEWAY_FAILURE = "Instagram relationship script returned no structured result.";

function storageQueue(storage) {
  return STORAGE_OPERATION_QUEUES.get(storage) || Promise.resolve();
}

function exclusiveForStorage(storage, operation) {
  const result = storageQueue(storage).then(operation, operation);
  STORAGE_OPERATION_QUEUES.set(storage, result.then(() => undefined, () => undefined));
  return result;
}

export function createEmptyFollowupState() {
  return {
    version: 2,
    automationEnabled: false,
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS },
    sources: [],
    candidates: [],
    run: { phase: "idle", activeBatch: null },
    history: [],
  };
}

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

function normalizeRun(run) {
  if (!run || typeof run !== "object") return { phase: "idle", activeBatch: null };
  const activeBatch = run.activeBatch ?? null;
  const normalized = {
    phase: typeof run.phase === "string" ? run.phase : "idle",
    activeBatch: activeBatch === null ? null : {
      kind: activeBatch.kind,
      candidateIds: activeBatch.candidateIds,
    },
  };
  for (const field of ["nextWorkAt", "nextSourceScanAt", "nextRelationshipReviewAt"]) {
    if (run[field] === undefined) continue;
    const value = new Date(run[field]);
    if (Number.isNaN(value.getTime()) || value.toISOString() !== run[field]) {
      throw new Error(`run.${field} must be a canonical ISO string.`);
    }
    normalized[field] = run[field];
  }
  if (run.sourceScanSourceId !== undefined) {
    if (typeof run.sourceScanSourceId !== "string" || !run.sourceScanSourceId.trim()) {
      throw new Error("run.sourceScanSourceId must be a non-empty string.");
    }
    normalized.sourceScanSourceId = normalizeSourceId(run.sourceScanSourceId);
  }
  if (run.liveTestSourceId !== undefined) {
    if (typeof run.liveTestSourceId !== "string" || !run.liveTestSourceId.trim()) {
      throw new Error("run.liveTestSourceId must be a non-empty string.");
    }
    normalized.liveTestSourceId = normalizeSourceId(run.liveTestSourceId);
  }
  if (run.liveTestCandidateIds !== undefined) {
    if (!Array.isArray(run.liveTestCandidateIds)
      || run.liveTestCandidateIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error("run.liveTestCandidateIds must be an array of candidate IDs.");
    }
    normalized.liveTestCandidateIds = [...new Set(run.liveTestCandidateIds)];
  }
  if (run.cycle !== undefined && run.cycle !== null) {
    const dueAt = new Date(run.cycle.dueAt);
    if (!run.cycle || typeof run.cycle !== "object"
      || !["review", "collect", "unfollow", "follow"].includes(run.cycle.stage)
      || Number.isNaN(dueAt.getTime()) || dueAt.toISOString() !== run.cycle.dueAt) {
      throw new Error("run.cycle must include a valid stage and canonical dueAt.");
    }
    normalized.cycle = { dueAt: run.cycle.dueAt, stage: run.cycle.stage };
  }
  if (run.lease !== undefined && run.lease !== null) {
    const expiresAt = new Date(run.lease.expiresAt);
    if (typeof run.lease.ownerId !== "string" || !run.lease.ownerId
      || Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString() !== run.lease.expiresAt) {
      throw new Error("run.lease must include an owner and canonical expiry.");
    }
    normalized.lease = {
      ownerId: run.lease.ownerId,
      expiresAt: run.lease.expiresAt,
    };
  }
  if (run.safetyDeadlineAt !== undefined) {
    const safetyDeadlineAt = new Date(run.safetyDeadlineAt);
    if (Number.isNaN(safetyDeadlineAt.getTime()) || safetyDeadlineAt.toISOString() !== run.safetyDeadlineAt) {
      throw new Error("run.safetyDeadlineAt must be a canonical ISO string.");
    }
    normalized.safetyDeadlineAt = run.safetyDeadlineAt;
  }
  if (run.inflightAction !== undefined && run.inflightAction !== null) {
    const startedAt = new Date(run.inflightAction.startedAt);
    if (typeof run.inflightAction.id !== "string" || !run.inflightAction.id
      || typeof run.inflightAction.candidateId !== "string" || !run.inflightAction.candidateId
      || !["follow", "unfollow"].includes(run.inflightAction.action)
      || Number.isNaN(startedAt.getTime()) || startedAt.toISOString() !== run.inflightAction.startedAt) {
      throw new Error("run.inflightAction must include a valid action intent.");
    }
    normalized.inflightAction = {
      id: run.inflightAction.id,
      candidateId: run.inflightAction.candidateId,
      action: run.inflightAction.action,
      startedAt: run.inflightAction.startedAt,
    };
  }
  if (run.externalOperation !== undefined && run.externalOperation !== null) {
    const startedAt = new Date(run.externalOperation.startedAt);
    if (typeof run.externalOperation.id !== "string" || !run.externalOperation.id
      || typeof run.externalOperation.ownerId !== "string" || !run.externalOperation.ownerId
      || !["action", "source_collection", "relationship_review"].includes(run.externalOperation.kind)
      || Number.isNaN(startedAt.getTime()) || startedAt.toISOString() !== run.externalOperation.startedAt) {
      throw new Error("run.externalOperation must include a valid durable operation fence.");
    }
    normalized.externalOperation = {
      id: run.externalOperation.id,
      ownerId: run.externalOperation.ownerId,
      kind: run.externalOperation.kind,
      startedAt: run.externalOperation.startedAt,
    };
  }
  return normalized;
}

function canonicalDate(values, direction) {
  const dates = values.filter((value) => typeof value === "string");
  if (!dates.length) return undefined;
  return dates.reduce((selected, value) => direction === "earliest"
    ? (value < selected ? value : selected)
    : (value > selected ? value : selected));
}

function mergeWarnings(sources, interrupted) {
  const warnings = sources
    .map(({ warning }) => typeof warning === "string" ? warning.trim() : "")
    .filter(Boolean);
  if (interrupted) warnings.push("Previous collection was interrupted and will be retried.");
  const unique = [...new Set(warnings)];
  return unique.length ? unique.join(" ") : undefined;
}

function mergedSourceStatus(sources) {
  const statuses = sources.map(({ status }) => status);
  if (statuses.length && statuses.every((status) => status === "completed")) return "completed";
  if (statuses.some((status) => status === "pending" || status === "collecting")) return "pending";
  return "error";
}

function migrateLegacySources(rawSources, backlogMaximum) {
  const aliases = new Map();
  const grouped = new Map();

  for (const source of rawSources) {
    const profileUrl = source?.profileUrl === undefined
      ? undefined
      : normalizeSourceInput(source.profileUrl);
    const canonicalId = profileUrl === undefined
      ? normalizeSourceId(source?.id)
      : sourceIdFromProfileUrl(profileUrl);
    const legacyId = normalizeSourceId(source?.id);
    const canonicalIds = aliases.get(legacyId) || new Set();
    canonicalIds.add(canonicalId);
    aliases.set(legacyId, canonicalIds);
    const group = grouped.get(canonicalId) || [];
    group.push({ ...source, id: canonicalId, profileUrl });
    grouped.set(canonicalId, group);
  }

  const sources = [...grouped.entries()].map(([id, group]) => {
    const interrupted = group.some(({ status }) => status === "collecting");
    const limit = Math.min(
      backlogMaximum,
      Math.max(...group.map(({ limit }) => Number.isInteger(limit) && limit > 0 ? limit : 0)),
    );
    const merged = {
      ...group[0],
      id,
      status: mergedSourceStatus(group),
    };
    const profileUrl = group.find((source) => source.profileUrl !== undefined)?.profileUrl;
    if (profileUrl !== undefined) merged.profileUrl = profileUrl;
    else delete merged.profileUrl;
    if (limit > 0) merged.limit = limit;
    for (const [field, direction] of [
      ["createdAt", "earliest"],
      ["updatedAt", "latest"],
      ["lastCollectedAt", "latest"],
    ]) {
      const value = canonicalDate(group.map((source) => source[field]), direction);
      if (value !== undefined) merged[field] = value;
      else delete merged[field];
    }
    const warning = mergeWarnings(group, interrupted);
    if (warning !== undefined) merged.warning = warning;
    else delete merged.warning;
    const collectionDepth = Math.max(...group.map(({ collectionDepth }) => (
      Number.isInteger(collectionDepth) && collectionDepth > 0 ? collectionDepth : 0
    )));
    if (collectionDepth > 0) merged.collectionDepth = Math.min(collectionDepth, merged.limit || backlogMaximum);
    else delete merged.collectionDepth;
    return merged;
  });

  return { sources, aliases };
}

function remapSourceIds(values, aliases) {
  if (!Array.isArray(values)) return values;
  return [...new Set(values.flatMap((value) => {
    const normalized = normalizeSourceId(value);
    return [...(aliases.get(normalized) || [normalized])];
  }))];
}

function isRejectedPrivateFollowRequest(entry) {
  return entry?.action === "follow"
    && entry.status === "failed"
    && entry.reason === PRIVATE_FOLLOW_REQUEST_GATEWAY_FAILURE
    && typeof entry.candidateId === "string"
    && entry.candidateId;
}

function repairRejectedPrivateFollowRequests({ settings, candidates, history }) {
  const requestsByCandidateId = new Map();
  for (const entry of history) {
    if (!isRejectedPrivateFollowRequest(entry)) continue;
    const previous = requestsByCandidateId.get(entry.candidateId);
    if (!previous || (entry.at || entry.timestamp) > (previous.at || previous.timestamp)) {
      requestsByCandidateId.set(entry.candidateId, entry);
    }
  }
  if (!requestsByCandidateId.size) return { candidates, history, repaired: false };

  const repairedHistory = history.map((entry) => isRejectedPrivateFollowRequest(entry)
    ? { ...entry, status: "follow_request_sent", reason: null }
    : entry);
  const repairedCandidates = candidates.map((candidate) => {
    const request = requestsByCandidateId.get(candidate.id);
    if (!request || candidate.status !== "skipped") return candidate;
    const followedAt = candidate.followedAt || request.at || request.timestamp;
    const unfollowDueAt = candidate.unfollowDueAt || new Date(
      new Date(followedAt).getTime() + (settings.unfollowDelayDays * 86_400_000),
    ).toISOString();
    const repaired = {
      ...candidate,
      status: "followed",
      followedAt,
      unfollowDueAt,
      followBackStatus: candidate.followBackStatus || "unknown",
      followBackReviewDueAt: candidate.followBackReviewDueAt || unfollowDueAt,
    };
    delete repaired.nextAction;
    delete repaired.failedAt;
    return repaired;
  });
  return { candidates: repairedCandidates, history: repairedHistory, repaired: true };
}

function normalizeFollowupState(rawState, now, { allowMissing = false, migrateLegacy = false } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid date.");
  if (rawState === undefined && allowMissing) return createEmptyFollowupState();
  if (typeof rawState !== "object" || Array.isArray(rawState)) throw new Error("Follow-up state must be an object.");
  if (rawState.version !== undefined && rawState.version !== 1 && rawState.version !== 2) {
    throw new Error("Unsupported follow-up state version.");
  }
  if (rawState.sources !== undefined && !Array.isArray(rawState.sources)) throw new Error("Follow-up state sources must be an array.");
  if (rawState.candidates !== undefined && !Array.isArray(rawState.candidates)) throw new Error("Follow-up state candidates must be an array.");
  if (rawState.history !== undefined && !Array.isArray(rawState.history)) throw new Error("Follow-up state history must be an array.");

  const settings = { ...DEFAULT_FOLLOWUP_SETTINGS, ...(rawState.settings || {}) };
  const migrated = migrateLegacy
    ? migrateLegacySources(rawState.sources || [], settings.backlogMaximum)
    : { sources: rawState.sources || [], aliases: new Map() };
  const sources = migrated.sources;
  const candidates = (rawState.candidates || []).map((candidate) => migrateLegacy ? ({
    ...candidate,
    ...(Array.isArray(candidate.sourceIds)
      ? { sourceIds: remapSourceIds(candidate.sourceIds, migrated.aliases) }
      : {}),
  }) : candidate);
  const history = (rawState.history || []).map((entry) => migrateLegacy ? ({
    ...entry,
    ...(Array.isArray(entry.sourceIds) ? { sourceIds: remapSourceIds(entry.sourceIds, migrated.aliases) } : {}),
  }) : entry);
  const run = normalizeRun(rawState.run);
  const repaired = repairRejectedPrivateFollowRequests({ settings, candidates, history });
  const exported = buildLocalExport({
    settings,
    sources,
    candidates: repaired.candidates,
    run,
    history: repaired.history,
  });

  return clone({
    version: 1,
    automationEnabled: rawState.automationEnabled === true,
    settings: exported.settings,
    sources: exported.sources,
    candidates: exported.candidates,
    run,
    history: exported.history,
  });
}

export function normalizeGrowthState(rawState, now, options = {}) {
  const normalized = normalizeFollowupState(rawState, now, options);
  return { ...normalized, version: 2 };
}

export function createFollowupStore({ storage, now = () => new Date() }) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("Follow-up storage must provide get and set.");
  }

  function exclusive(operation) {
    return exclusiveForStorage(storage, operation);
  }

  async function loadRaw() {
    const stored = await storage.get([
      INSTAGRAM_GROWTH_STATE_KEY,
      LEGACY_INSTAGRAM_FOLLOWUP_STATE_KEY,
    ]);
    const storedState = stored[INSTAGRAM_GROWTH_STATE_KEY];
    const legacyState = stored[LEGACY_INSTAGRAM_FOLLOWUP_STATE_KEY];
    const state = normalizeGrowthState(
      storedState === undefined ? legacyState : storedState,
      now(),
      { allowMissing: true, migrateLegacy: true },
    );
    const needsPrivateRequestRepair = Array.isArray(storedState?.history)
      && storedState.history.some(isRejectedPrivateFollowRequest);
    if ((storedState === undefined && legacyState !== undefined) || needsPrivateRequestRepair) {
      await storage.set({ [INSTAGRAM_GROWTH_STATE_KEY]: state });
    }
    return state;
  }

  async function saveRaw(state) {
    const normalized = normalizeGrowthState(state, now());
    await storage.set({ [INSTAGRAM_GROWTH_STATE_KEY]: normalized });
    return clone(normalized);
  }

  function load() {
    return storageQueue(storage).then(loadRaw);
  }

  function save(state) {
    return exclusive(() => saveRaw(state));
  }

  function update(mutator) {
    if (typeof mutator !== "function") throw new Error("Follow-up update mutator must be a function.");
    return exclusive(async () => {
      const state = freeze(await loadRaw());
      const updated = mutator(state);
      if (updated && typeof updated.then === "function") {
        throw new Error("Follow-up update mutator must be synchronous.");
      }
      return saveRaw(updated);
    });
  }

  async function exportJson() {
    return JSON.stringify(buildLocalExport(await load()));
  }

  async function importJson(json) {
    if (typeof json !== "string") throw new Error("The import file must contain JSON text.");
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("The import file is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The import file must contain a growth state object.");
    }
    return save(parsed);
  }

  function reset() {
    return save(createEmptyFollowupState());
  }

  return {
    load,
    save,
    update,
    exportJson,
    importJson,
    reset,
    [FOLLOWUP_STORE_SYNCHRONIZATION_KEY]: storage,
  };
}

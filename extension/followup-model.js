export const DEFAULT_FOLLOWUP_SETTINGS = Object.freeze({
  perSourceLimit: 200,
  backlogMaximum: 500,
  refillThreshold: 100,
  sourceRescanHours: 6,
  cycleIntervalHours: 4,
  batchSize: 50,
  activeFollowCap: 1000,
  actionDelayMinSeconds: 5,
  actionDelayMaxSeconds: 10,
  batchDelayMinMinutes: 5,
  batchDelayMaxMinutes: 7,
  unfollowDelayDays: 2,
  followBackUnfollowDelayDays: 7,
});

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const CANDIDATE_STATUSES = new Set([
  "pending_follow",
  "following",
  "followed",
  "pending_unfollow",
  "unfollowing",
  "unfollowed",
  "skipped",
  "failed",
]);
const ACTION_KINDS = new Set(["follow", "unfollow"]);
const FOLLOW_BACK_STATUSES = new Set(["unknown", "confirmed"]);
const RESERVED_PROFILE_PATHS = new Set(["accounts", "about", "developer", "direct", "explore", "legal", "p", "privacy", "reel", "reels", "stories", "terms", "web"]);
const SOURCE_EXPORT_FIELDS = ["id", "profileUrl", "limit", "status", "createdAt", "updatedAt", "lastCollectedAt", "warning", "collectionDepth"];
const CANDIDATE_EXPORT_FIELDS = ["id", "handle", "profileUrl", "normalizedHandle", "sourceIds", "status", "createdAt", "updatedAt", "followedAt", "followBackStatus", "lastFollowBackCheckAt", "followBackAt", "followBackReviewDueAt", "unfollowDueAt", "unfollowedAt", "failedAt", "nextAction"];
const HISTORY_EXPORT_FIELDS = [
  "candidateId",
  "action",
  "kind",
  "handle",
  "sourceIds",
  "status",
  "reason",
  "timestamp",
  "at",
];
const SETTINGS_EXPORT_FIELDS = Object.keys(DEFAULT_FOLLOWUP_SETTINGS);
const POSITIVE_INTEGER_SETTINGS = [
  "perSourceLimit",
  "backlogMaximum",
  "refillThreshold",
  "batchSize",
  "activeFollowCap",
];
const POSITIVE_NUMBER_SETTINGS = [
  "actionDelayMinSeconds",
  "actionDelayMaxSeconds",
  "batchDelayMinMinutes",
  "batchDelayMaxMinutes",
  "sourceRescanHours",
  "cycleIntervalHours",
  "unfollowDelayDays",
  "followBackUnfollowDelayDays",
];

function toIsoDate(value, fieldName = "date") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid date.`);
  return date.toISOString();
}

function normalizeHandle(value) {
  if (typeof value !== "string") throw new Error("Instagram profile handle must be a string.");
  const handle = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
    throw new Error("Enter an Instagram profile handle or profile URL.");
  }
  return handle;
}

export function normalizeSourceId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("A source ID is required.");
  return value.trim().toLowerCase();
}

function candidateKey(candidate) {
  return (candidate.normalizedHandle || normalizeHandle(candidate.handle)).toLowerCase();
}

function assertCanonicalIsoDate(value, fieldName) {
  if (typeof value !== "string" || value !== toIsoDate(value, fieldName)) {
    throw new Error(`${fieldName} must be a canonical ISO string.`);
  }
}

function assertCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("Candidate must be an object.");
  if (typeof candidate.id !== "string" || !candidate.id) throw new Error("Candidate ID is required.");
  normalizeHandle(candidate.handle);
  if (!CANDIDATE_STATUSES.has(candidate.status)) throw new Error("Candidate has an invalid status.");
  if (candidate.followBackStatus !== undefined && !FOLLOW_BACK_STATUSES.has(candidate.followBackStatus)) {
    throw new Error("Candidate has an invalid followBackStatus.");
  }
  if (candidate.status === "failed" && !ACTION_KINDS.has(candidate.nextAction)) {
    throw new Error("Failed candidates must include a retryable nextAction.");
  }
  for (const field of ["createdAt", "updatedAt", "followedAt", "lastFollowBackCheckAt", "followBackAt", "followBackReviewDueAt", "unfollowDueAt", "unfollowedAt", "failedAt"]) {
    if (candidate[field] !== undefined) assertCanonicalIsoDate(candidate[field], field);
  }
}

function assertUniqueSources(sources) {
  const ids = new Set();
  const identities = new Set();
  for (const source of sources) {
    if (!source || typeof source !== "object") throw new Error("Source must be an object.");
    const id = normalizeSourceId(source.id);
    if (ids.has(id)) throw new Error("Follow-up source IDs must be unique case-insensitively.");
    ids.add(id);
    if (source.profileUrl === undefined) continue;
    const identity = sourceIdFromProfileUrl(source.profileUrl);
    if (identities.has(identity)) throw new Error("Follow-up source identities must be unique case-insensitively.");
    identities.add(identity);
  }
}

export function validateFollowupSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Follow-up settings must be an object.");
  }
  const unknown = Object.keys(settings).filter((field) => !SETTINGS_EXPORT_FIELDS.includes(field));
  if (unknown.length) throw new Error(`Follow-up settings include an unsupported field: ${unknown[0]}.`);

  for (const field of POSITIVE_INTEGER_SETTINGS) {
    if (!Number.isInteger(settings[field]) || settings[field] <= 0) {
      throw new Error(`Follow-up settings require a positive integer ${field}.`);
    }
  }
  for (const field of POSITIVE_NUMBER_SETTINGS) {
    if (!Number.isFinite(settings[field]) || settings[field] <= 0) {
      throw new Error(`Follow-up settings require a positive ${field}.`);
    }
  }
  if (settings.refillThreshold >= settings.backlogMaximum) {
    throw new Error("Follow-up settings require refillThreshold below backlogMaximum.");
  }
  if (settings.batchSize > settings.backlogMaximum) {
    throw new Error("Follow-up settings require batchSize at or below backlogMaximum.");
  }
  if (settings.perSourceLimit > settings.backlogMaximum) {
    throw new Error("Follow-up settings require perSourceLimit at or below backlogMaximum.");
  }
  if (settings.actionDelayMinSeconds > settings.actionDelayMaxSeconds) {
    throw new Error("Follow-up settings action delay minimum cannot exceed its maximum.");
  }
  if (settings.batchDelayMinMinutes > settings.batchDelayMaxMinutes) {
    throw new Error("Follow-up settings batch delay minimum cannot exceed its maximum.");
  }
  return settings;
}

function assertState(state) {
  if (!state || typeof state !== "object") throw new Error("Follow-up state is required.");
  if (state.sources !== undefined && !Array.isArray(state.sources)) throw new Error("Follow-up state sources must be an array.");
  if (!Array.isArray(state.candidates)) throw new Error("Follow-up state candidates must be an array.");
  validateFollowupSettings(state.settings);
  if (state.run && state.run.activeBatch !== null && state.run.activeBatch !== undefined) {
    const { kind, candidateIds } = state.run.activeBatch;
    if (!ACTION_KINDS.has(kind) || !Array.isArray(candidateIds)) throw new Error("Active batch is invalid.");
  }
  assertUniqueSources(state.sources || []);
  state.candidates.forEach(assertCandidate);
}

function addDays(iso, days) {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function actionPriority(candidate) {
  if (candidate.status === "pending_unfollow") return 6;
  if (candidate.status === "following" || candidate.status === "unfollowing") return 5;
  if (candidate.status === "failed" && candidate.nextAction === "unfollow") return 4;
  if (candidate.status === "followed") return 3;
  if (candidate.status === "pending_follow" || candidate.status === "failed") return 2;
  return 1;
}

function mergeDuplicateCandidates(first, second) {
  const preferred = actionPriority(second) > actionPriority(first) ? second : first;
  return {
    ...preferred,
    sourceIds: [...new Set([...(first.sourceIds || []), ...(second.sourceIds || [])])],
  };
}

function pickFields(value, fields) {
  return Object.fromEntries(fields.flatMap((field) => (
    Object.hasOwn(value, field) ? [[field, value[field]]] : []
  )));
}

function parseSourceInput(value) {
  if (typeof value !== "string") throw new Error("Enter an Instagram profile handle or profile URL.");
  const input = value.trim();
  if (!input) throw new Error("Enter an Instagram profile handle or profile URL.");

  if (!input.includes("://")) {
    const handle = normalizeHandle(input);
    return { handle, profileUrl: `https://www.instagram.com/${handle.toLowerCase()}/` };
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid Instagram profile URL.");
  }
  if (url.protocol !== "https:" || !INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Enter a valid Instagram profile URL.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) throw new Error("Enter an Instagram profile URL, not a post or page.");
  const handle = normalizeHandle(segments[0]);
  if (RESERVED_PROFILE_PATHS.has(handle.toLowerCase())) {
    throw new Error("Enter an Instagram profile URL, not an Instagram page.");
  }
  return { handle, profileUrl: `https://www.instagram.com/${handle.toLowerCase()}/` };
}

export function normalizeSourceInput(value) {
  return parseSourceInput(value).profileUrl;
}

export function sourceIdFromProfileUrl(value) {
  const profileUrl = normalizeSourceInput(value);
  const handle = new URL(profileUrl).pathname.split("/").filter(Boolean)[0];
  return `instagram-source:${handle}`;
}

export function normalizeCandidate(raw, rawSourceId, now = new Date()) {
  const source = normalizeSourceId(rawSourceId);
  const input = typeof raw === "string" ? raw : raw?.profileUrl || raw?.url || raw?.handle;
  const { handle, profileUrl } = parseSourceInput(input);
  const at = toIsoDate(now, "now");
  const normalizedHandle = handle.toLowerCase();
  return {
    id: `instagram:${normalizedHandle}`,
    handle,
    profileUrl,
    normalizedHandle,
    sourceIds: [source],
    status: "pending_follow",
    createdAt: at,
    updatedAt: at,
  };
}

export function mergeCandidates(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) throw new Error("Candidates must be arrays.");
  const byHandle = new Map();
  for (const candidate of existing) {
    assertCandidate(candidate);
    const normalized = { ...candidate, sourceIds: [...new Set(candidate.sourceIds || [])] };
    const key = candidateKey(normalized);
    byHandle.set(key, byHandle.has(key) ? mergeDuplicateCandidates(byHandle.get(key), normalized) : normalized);
  }

  for (const raw of incoming) {
    const candidate = normalizeCandidate(raw, raw?.sourceId);
    const current = byHandle.get(candidate.normalizedHandle);
    if (!current) {
      byHandle.set(candidate.normalizedHandle, candidate);
      continue;
    }
    byHandle.set(candidate.normalizedHandle, mergeDuplicateCandidates(current, candidate));
  }
  return [...byHandle.values()];
}

export function getPendingFollowCount(state) {
  assertState(state);
  return state.candidates.filter(({ status }) => status === "pending_follow").length;
}

export function countActiveFollows(state) {
  assertState(state);
  return state.candidates.filter(({ status }) => (
    status === "followed" || status === "pending_unfollow" || status === "unfollowing"
  )).length;
}

export function getDueUnfollowCandidates(state, now = new Date()) {
  assertState(state);
  const at = toIsoDate(now, "now");
  return state.candidates.filter((candidate) => (
    (candidate.status === "failed" && candidate.nextAction === "unfollow")
    || (candidate.status === "pending_unfollow"
      && candidate.unfollowDueAt !== undefined
      && candidate.unfollowDueAt <= at)
  ));
}

export function selectNextBatch(state, now = new Date()) {
  assertState(state);
  if (state.run?.activeBatch) return null;
  const liveTestSourceId = state.run?.liveTestSourceId;
  const liveTestCandidateIds = new Set(state.run?.liveTestCandidateIds || []);
  const belongsToLiveTest = (candidate) => !liveTestSourceId
    || liveTestCandidateIds.has(candidate.id);
  const due = getDueUnfollowCandidates(state, now)
    .filter(belongsToLiveTest)
    .slice(0, state.settings.batchSize);
  if (due.length) return { kind: "unfollow", candidateIds: due.map(({ id }) => id) };
  const follows = state.candidates.filter(({ status, nextAction }) => (
    status === "pending_follow" || (status === "failed" && nextAction === "follow")
  )).filter(belongsToLiveTest).slice(0, state.settings.batchSize);
  return follows.length ? { kind: "follow", candidateIds: follows.map(({ id }) => id) } : null;
}

function belongsToActiveLiveTest(state, candidate) {
  if (!state.run?.liveTestSourceId) return true;
  return new Set(state.run.liveTestCandidateIds || []).has(candidate.id);
}

export function selectNextWork(state, now = new Date()) {
  assertState(state);
  const at = toIsoDate(now, "now");
  if (state.run?.activeBatch) return { kind: "action", batch: state.run.activeBatch };

  const batch = selectNextBatch(state, now);
  if (batch?.kind === "unfollow") return { kind: "action", batch };
  if (state.run?.nextRelationshipReviewAt !== undefined
    && state.run.nextRelationshipReviewAt <= at) {
    return { kind: "relationship_review" };
  }
  if (batch?.kind === "follow") return { kind: "action", batch };
  if (state.run?.nextSourceScanAt !== undefined && state.run.nextSourceScanAt <= at) {
    return { kind: "source_scan" };
  }
  return { kind: "idle" };
}

export function scheduleFollowBackReview(state, now = new Date()) {
  assertState(state);
  const at = toIsoDate(now, "now");
  const candidates = state.candidates.map((candidate) => {
    if (!belongsToActiveLiveTest(state, candidate)
      || candidate.status !== "followed" || candidate.followBackStatus === "confirmed") return { ...candidate };
    const followBackStatus = candidate.followBackStatus || "unknown";
    const followBackReviewDueAt = candidate.followBackReviewDueAt
      || candidate.unfollowDueAt
      || addDays(candidate.followedAt || at, state.settings.unfollowDelayDays);
    if (candidate.followBackStatus === followBackStatus && candidate.followBackReviewDueAt === followBackReviewDueAt) {
      return { ...candidate };
    }
    return { ...candidate, followBackStatus, followBackReviewDueAt, updatedAt: at };
  });
  return { ...state, candidates };
}

export function applyFollowBackReview(state, handles, now = new Date()) {
  assertState(state);
  if (!Array.isArray(handles)) throw new Error("Follow-back review handles must be an array.");
  const at = toIsoDate(now, "now");
  const matchedHandles = new Set(handles.map((handle) => normalizeHandle(handle).toLowerCase()));
  const candidates = state.candidates.map((candidate) => {
    if (!belongsToActiveLiveTest(state, candidate) || candidate.status !== "followed") return { ...candidate };
    if (matchedHandles.has(candidateKey(candidate))) {
      return {
        ...candidate,
        followBackStatus: "confirmed",
        lastFollowBackCheckAt: at,
        followBackAt: candidate.followBackAt || at,
        // A confirmed follow-back is an explicit result of this completed review,
        // so it is eligible for the unfollow portion of the same cycle.
        unfollowDueAt: at,
        updatedAt: at,
      };
    }
    return {
      ...candidate,
      followBackStatus: candidate.followBackStatus || "unknown",
      lastFollowBackCheckAt: at,
      updatedAt: at,
    };
  });
  return { ...state, candidates };
}

export function nextDueLifecycleAt(state, now = new Date()) {
  assertState(state);
  const at = toIsoDate(now, "now");
  const dueDates = state.candidates.flatMap((candidate) => {
    if (!belongsToActiveLiveTest(state, candidate)) return [];
    if (candidate.status !== "followed" && candidate.status !== "pending_unfollow") return [];
    const dates = [];
    if (candidate.status === "followed"
      && candidate.followBackStatus !== "confirmed"
      && candidate.followBackReviewDueAt !== undefined) {
      dates.push(candidate.followBackReviewDueAt);
    }
    if (candidate.unfollowDueAt !== undefined) dates.push(candidate.unfollowDueAt);
    return dates;
  });
  if (!dueDates.length) return null;
  const earliest = dueDates.reduce((current, dueAt) => dueAt < current ? dueAt : current);
  return earliest < at ? at : earliest;
}

export function applyActionOutcome(state, action, outcome, now = new Date()) {
  assertState(state);
  if (!action || !ACTION_KINDS.has(action.kind) || typeof action.candidateId !== "string") {
    throw new Error("Action kind and candidate ID are required.");
  }
  const at = toIsoDate(now, "now");
  const candidateIndex = state.candidates.findIndex(({ id }) => id === action.candidateId);
  if (candidateIndex === -1) throw new Error("Action candidate was not found.");
  const candidate = state.candidates[candidateIndex];
  const succeeded = outcome?.validated === true && outcome?.success === true;
  const updatedCandidate = { ...candidate, updatedAt: at };

  if (succeeded && action.kind === "follow") {
    updatedCandidate.status = "followed";
    updatedCandidate.followedAt = at;
    updatedCandidate.unfollowDueAt = addDays(at, state.settings.unfollowDelayDays);
    updatedCandidate.followBackStatus = "unknown";
    updatedCandidate.followBackReviewDueAt = updatedCandidate.unfollowDueAt;
    delete updatedCandidate.nextAction;
  } else if (succeeded) {
    updatedCandidate.status = "unfollowed";
    updatedCandidate.unfollowedAt = at;
    delete updatedCandidate.nextAction;
  } else {
    updatedCandidate.status = "failed";
    updatedCandidate.nextAction = action.kind;
    updatedCandidate.failedAt = at;
  }

  const event = {
    candidateId: candidate.id,
    action: action.kind,
    kind: action.kind,
    handle: candidate.handle,
    sourceIds: [...(candidate.sourceIds || [])],
    status: succeeded ? "succeeded" : "failed",
    reason: !succeeded && typeof outcome?.reason === "string" && outcome.reason ? outcome.reason : null,
    timestamp: at,
    at,
  };
  const candidates = state.candidates.map((item, index) => index === candidateIndex ? updatedCandidate : { ...item });
  return { ...state, candidates, history: [...(state.history || []), event] };
}

export function buildLocalExport(state) {
  assertState(state);
  return {
    version: state.version === 2 ? 2 : 1,
    settings: pickFields(state.settings, SETTINGS_EXPORT_FIELDS),
    sources: (state.sources || []).map((source) => pickFields(source, SOURCE_EXPORT_FIELDS)),
    candidates: state.candidates.map((candidate) => pickFields(candidate, CANDIDATE_EXPORT_FIELDS)),
    history: (state.history || []).map((entry) => pickFields(entry, HISTORY_EXPORT_FIELDS)),
  };
}

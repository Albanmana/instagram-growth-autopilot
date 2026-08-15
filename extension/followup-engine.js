import {
  applyFollowBackReview,
  countActiveFollows,
  getPendingFollowCount,
  nextDueLifecycleAt,
  normalizeCandidate,
  normalizeSourceInput,
  scheduleFollowBackReview,
  selectNextBatch,
  selectNextWork,
  validateFollowupSettings,
} from "./followup-model.js";
import { FOLLOWUP_STORE_SYNCHRONIZATION_KEY } from "./followup-store.js";

export const INSTAGRAM_FOLLOWUP_NEXT_ALARM = "INSTAGRAM_FOLLOWUP_NEXT_WORK";

const LEASE_DURATION_MS = 15 * 60_000;
const PHASES = new Set([
  "idle",
  "collecting",
  "reviewing",
  "running_batch",
  "waiting",
  "paused",
  "blocked",
  "stopped",
  "recovery_required",
]);
const ENGINE_QUEUES = new WeakMap();
let engineSequence = 0;

function validDate(value, name) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must return a valid Date.`);
  return date;
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Unknown error");
}

function randomDelay(random, minimum, maximum) {
  const sample = Number(random());
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return minimum + ((maximum - minimum) * normalized);
}

function sourceIdentifier(profileUrl) {
  const handle = new URL(profileUrl).pathname.split("/").filter(Boolean)[0].toLowerCase();
  return `instagram-source:${handle}`;
}

function canonicalSourceId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("A source ID is required.");
  return value.trim().toLowerCase();
}

function candidateById(state, candidateId) {
  return state.candidates.find(({ id }) => id === candidateId);
}

function updateRun(state, changes, removedFields = []) {
  const run = { ...state.run, ...changes };
  for (const field of removedFields) delete run[field];
  return { ...state, run };
}

function replaceCandidate(state, candidateId, mutate) {
  return {
    ...state,
    candidates: state.candidates.map((candidate) => (
      candidate.id === candidateId ? mutate({ ...candidate }) : candidate
    )),
  };
}

function replaceSource(state, sourceId, mutate) {
  const canonicalId = canonicalSourceId(sourceId);
  return {
    ...state,
    sources: state.sources.map((source) => (
      canonicalSourceId(source.id) === canonicalId ? mutate({ ...source }) : source
    )),
  };
}

function mergeCollectedCandidates(state, rawCandidates, sourceId, at, maximum) {
  const candidates = state.candidates.map((candidate) => ({
    ...candidate,
    sourceIds: [...(candidate.sourceIds || [])],
  }));
  const byHandle = new Map(candidates.map((candidate, index) => [candidate.normalizedHandle, index]));
  let pendingCount = getPendingFollowCount({ ...state, candidates });

  for (const rawCandidate of rawCandidates || []) {
    const normalized = normalizeCandidate(rawCandidate, sourceId, at);
    const existingIndex = byHandle.get(normalized.normalizedHandle);
    if (existingIndex !== undefined) {
      const existing = candidates[existingIndex];
      candidates[existingIndex] = {
        ...existing,
        sourceIds: [...new Set([...(existing.sourceIds || []), sourceId])],
        updatedAt: at.toISOString(),
      };
      continue;
    }
    if (pendingCount >= maximum) break;
    byHandle.set(normalized.normalizedHandle, candidates.length);
    candidates.push(normalized);
    pendingCount += 1;
  }

  return { ...state, candidates };
}

function enqueueForStore(store, operation) {
  const synchronizationKey = store[FOLLOWUP_STORE_SYNCHRONIZATION_KEY] || store;
  const previous = ENGINE_QUEUES.get(synchronizationKey) || Promise.resolve();
  const result = previous.then(operation, operation);
  ENGINE_QUEUES.set(synchronizationKey, result.then(() => undefined, () => undefined));
  return result;
}

function earliestFutureUnfollow(state, now) {
  const nowMs = now.getTime();
  let earliest = null;
  for (const candidate of state.candidates) {
    if (!["followed", "pending_unfollow"].includes(candidate.status) || !candidate.unfollowDueAt) continue;
    if (candidate.status === "followed"
      && candidate.followBackStatus !== "confirmed"
      && (!candidate.followBackReviewDueAt
        || !candidate.lastFollowBackCheckAt
        || candidate.lastFollowBackCheckAt < candidate.followBackReviewDueAt)) continue;
    const due = validDate(candidate.unfollowDueAt, "unfollowDueAt");
    if (due.getTime() <= nowMs) continue;
    if (!earliest || due < earliest) earliest = due;
  }
  return earliest;
}

function earliestDate(dates) {
  return dates.reduce((earliest, candidate) => candidate < earliest ? candidate : earliest);
}

function latestDate(dates) {
  return dates.reduce((latest, candidate) => candidate > latest ? candidate : latest);
}

function futureRunDate(value, now, name) {
  if (!value) return null;
  const date = validDate(value, name);
  return date > now ? date : null;
}

function sourceCollectionLimit(state, source, remaining) {
  const configuredLimit = source.limit || state.settings.perSourceLimit;
  const previousDepth = Number.isInteger(source.collectionDepth) && source.collectionDepth > 0
    ? Math.min(source.collectionDepth, configuredLimit)
    : 0;
  return Math.min(configuredLimit, previousDepth + remaining);
}

function isPreviouslyCollectedSource(source) {
  return Number.isFinite(Date.parse(source.lastCollectedAt));
}

function sourceScanLimit(state, source, remaining) {
  return isPreviouslyCollectedSource(source)
    ? (source.limit || state.settings.perSourceLimit)
    : sourceCollectionLimit(state, source, remaining);
}

function isSourceRescanDue(source, now, rescanHours) {
  if (source.status !== "completed") return false;
  const lastCollectedMs = Date.parse(source.lastCollectedAt);
  if (!Number.isFinite(lastCollectedMs)) return false;
  return now.getTime() - lastCollectedMs >= rescanHours * 3_600_000;
}

function isSourceScanEligible(source, now, rescanHours) {
  return source.status === "pending"
    || source.status === "error"
    || isSourceRescanDue(source, now, rescanHours);
}

export function nextSourceRescanDate(state, current) {
  if (getPendingFollowCount(state) >= state.settings.refillThreshold) return null;
  const dueDates = state.sources
    .filter((source) => (
      source.status === "completed"
      && !isSourceRescanDue(source, current, state.settings.sourceRescanHours)
    ))
    .map((source) => new Date(Date.parse(source.lastCollectedAt) + (state.settings.sourceRescanHours * 3_600_000)))
    .filter((date) => Number.isFinite(date.getTime()));
  if (!dueDates.length) return null;
  return earliestDate(dueDates);
}

function sourceRotationTimestamp(source) {
  for (const value of [source.lastCollectedAt, source.updatedAt, source.createdAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.POSITIVE_INFINITY;
}

function nextAutomaticSource(sources, attempted, now, rescanHours) {
  let selected = null;
  let selectedTimestamp = Number.POSITIVE_INFINITY;
  for (const source of sources) {
    if (attempted.has(source.id) || !isSourceScanEligible(source, now, rescanHours)) continue;
    const timestamp = sourceRotationTimestamp(source);
    // Keep the persisted list order as a deterministic tie-breaker.
    if (!selected || timestamp < selectedTimestamp) {
      selected = source;
      selectedTimestamp = timestamp;
    }
  }
  return selected;
}

export function createFollowupEngine({
  store,
  collectFollowers,
  collectOwnFollowerHandles,
  collectAndFollowFollowers,
  performAction,
  schedule,
  clearSchedule,
  balancedCycles = false,
  now = () => new Date(),
  random = Math.random,
} = {}) {
  if (!store || typeof store.load !== "function" || typeof store.save !== "function" || typeof store.update !== "function") {
    throw new Error("Follow-up engine store must provide load, save and update.");
  }
  for (const [name, dependency] of Object.entries({
    collectFollowers,
    collectOwnFollowerHandles,
    performAction,
    schedule,
    clearSchedule,
    now,
    random,
  })) {
    if (typeof dependency !== "function") throw new Error(`${name} must be a function.`);
  }
  if (collectAndFollowFollowers !== undefined && typeof collectAndFollowFollowers !== "function") {
    throw new Error("collectAndFollowFollowers must be a function.");
  }

  engineSequence += 1;
  const instanceToken = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${engineSequence}-${Math.random().toString(36).slice(2)}`;
  const ownerId = `followup-engine:${instanceToken}`;
  let activeCollectionController = null;
  let externalOperationSequence = 0;

  function currentDate() {
    return validDate(now(), "now");
  }

  function enqueue(operation) {
    return enqueueForStore(store, operation);
  }

  function expectedInflightStatus(action) {
    return action === "follow" ? "following" : "unfollowing";
  }

  function actionIntentMatches(intent, candidate, action) {
    return Boolean(
      intent
      && candidate
      && typeof intent.id === "string"
      && intent.id
      && intent.candidateId === candidate.id
      && intent.action === action
      && candidate.status === expectedInflightStatus(action),
    );
  }

  function actionIntent(candidate, action, startedAt) {
    return {
      id: `${action}:${candidate.id}:${startedAt}`,
      candidateId: candidate.id,
      action,
      startedAt,
    };
  }

  function markExternalOperation(state, kind, referenceId) {
    if (state.run?.externalOperation) {
      throw new Error("Follow-up engine cannot overlap persisted external operations.");
    }
    externalOperationSequence += 1;
    const startedAt = currentDate().toISOString();
    const operation = {
      id: `${kind}:${referenceId || startedAt}:${externalOperationSequence}`,
      ownerId,
      kind,
      startedAt,
    };
    return {
      operation,
      state: updateRun(state, { externalOperation: operation }),
    };
  }

  function operationMatches(left, right) {
    return Boolean(
      left
      && right
      && left.id === right.id
      && left.ownerId === right.ownerId,
    );
  }

  function recoveryRequired(state) {
    return state.run?.phase === "recovery_required";
  }

  function preserveRecoveryRequired(state) {
    return updateRun(state, { phase: "recovery_required" }, ["nextWorkAt"]);
  }

  function workMayRun(state) {
    const manualSourceScanQueued = Boolean(
      state.run?.nextSourceScanAt && state.run?.sourceScanSourceId,
    );
    if (["paused", "recovery_required"].includes(state.run?.phase)) return false;
    if (state.run?.phase === "stopped" && !manualSourceScanQueued) return false;
    return state.automationEnabled || manualSourceScanQueued;
  }

  function recoverPersistedInflightIntent(state, at) {
    if (state.run?.inflightAction) return state;
    const batch = state.run?.activeBatch;
    const candidate = batch?.candidateIds?.[0]
      ? candidateById(state, batch.candidateIds[0])
      : null;
    if (!candidate || candidate.status !== expectedInflightStatus(batch.kind)) return state;
    const startedAt = candidate.updatedAt || at.toISOString();
    return updateRun(state, { inflightAction: actionIntent(candidate, batch.kind, startedAt) });
  }

  function reconcileInterruptedActionState(state, at) {
    let batch = state.run?.activeBatch;
    let intent = state.run?.inflightAction;

    if (!batch && intent) {
      const candidate = candidateById(state, intent.candidateId);
      if (candidate && candidate.status === expectedInflightStatus(intent.action)) {
        batch = { kind: intent.action, candidateIds: [candidate.id] };
        state = updateRun(state, { phase: "running_batch", activeBatch: batch });
      } else {
        intent = null;
        state = updateRun(state, {}, ["inflightAction"]);
      }
    }

    const activeCandidate = batch?.candidateIds?.[0]
      ? candidateById(state, batch.candidateIds[0])
      : null;
    if (intent && !actionIntentMatches(intent, activeCandidate, batch?.kind)) {
      intent = null;
      state = updateRun(state, {}, ["inflightAction"]);
    }

    const activeTransientId = activeCandidate
      && activeCandidate.status === expectedInflightStatus(batch?.kind)
      ? activeCandidate.id
      : null;
    const iso = at.toISOString();
    state = {
      ...state,
      candidates: state.candidates.map((candidate) => {
        if (!["following", "unfollowing"].includes(candidate.status) || candidate.id === activeTransientId) {
          return candidate;
        }
        return {
          ...candidate,
          status: "failed",
          nextAction: candidate.status === "following" ? "follow" : "unfollow",
          failedAt: iso,
          updatedAt: iso,
        };
      }),
    };
    return state;
  }

  async function persist(state) {
    return store.update((current) => {
      if (state.run?.lease?.ownerId === ownerId && current.run?.lease?.ownerId !== ownerId) {
        throw new Error("Follow-up engine lease ownership was lost before persistence.");
      }
      if (recoveryRequired(current)) return preserveRecoveryRequired(state);
      return state;
    });
  }

  async function persistExternalOperation(state) {
    return persist(state);
  }

  async function acquireLease({
    preemptControlledLease = false,
    blockRecovery = false,
  } = {}) {
    const acquiredAt = currentDate();
    const acquiredIso = acquiredAt.toISOString();
    const expiresAt = new Date(acquiredAt.getTime() + LEASE_DURATION_MS).toISOString();
    let acquired = false;
    const state = await store.update((current) => {
      if (blockRecovery && recoveryRequired(current)) return current;
      const lease = current.run?.lease;
      const controlledTakeover = preemptControlledLease
        && ["paused", "stopped"].includes(current.run?.phase);
      const foreignExternalOperation = current.run?.externalOperation
        && current.run.externalOperation.ownerId !== ownerId;
      if (foreignExternalOperation && !controlledTakeover) return current;
      if (lease && lease.ownerId !== ownerId && lease.expiresAt > acquiredIso && !controlledTakeover) {
        return current;
      }
      acquired = true;
      return updateRun(current, { lease: { ownerId, expiresAt } });
    });
    return { acquired, state };
  }

  async function releaseLease() {
    await store.update((current) => {
      if (current.run?.lease?.ownerId !== ownerId) return current;
      return updateRun(current, {}, ["lease"]);
    });
  }

  async function acknowledgeExternalOperation(operation) {
    const completedAt = currentDate();
    let wakeAt = null;
    await store.update((current) => {
      if (!operationMatches(current.run?.externalOperation, operation)) return current;
      let state = updateRun(current, {}, ["externalOperation"]);
      const ownerStillHoldsLease = state.run?.lease?.ownerId === ownerId;
      if (!ownerStillHoldsLease && workMayRun(state)) {
        const safetyDeadline = futureRunDate(
          state.run?.safetyDeadlineAt,
          completedAt,
          "safetyDeadlineAt",
        );
        wakeAt = safetyDeadline || completedAt;
        state = updateRun(state, { nextWorkAt: wakeAt.toISOString() });
      }
      return state;
    });
    if (wakeAt) await schedule(wakeAt, INSTAGRAM_FOLLOWUP_NEXT_ALARM, { safety: true });
  }

  async function scheduleBusyLease(state) {
    if (recoveryRequired(state)) {
      await clearSchedule(INSTAGRAM_FOLLOWUP_NEXT_ALARM);
      return;
    }
    const current = currentDate();
    const dates = [state.run?.nextWorkAt, state.run?.safetyDeadlineAt, state.run?.lease?.expiresAt]
      .filter(Boolean)
      .map((value) => validDate(value, "scheduled work"))
      .filter((date) => date > current);
    if (!dates.length) return;
    const at = latestDate(dates);
    await schedule(at, INSTAGRAM_FOLLOWUP_NEXT_ALARM, { safety: true });
  }

  async function withLease(work, options) {
    const claim = await acquireLease(options);
    if (!claim.acquired) {
      await scheduleBusyLease(claim.state);
      return { acquired: false, state: claim.state };
    }
    try {
      return { acquired: true, value: await work(claim.state) };
    } finally {
      await releaseLease();
    }
  }

  async function scheduleAt(state, at, { safety = false } = {}) {
    const current = currentDate();
    let date = validDate(at, "schedule date");
    const existingSafety = futureRunDate(state.run?.safetyDeadlineAt, current, "safetyDeadlineAt");
    if (existingSafety && existingSafety > date) date = existingSafety;
    if (safety) {
      state = updateRun(state, { safetyDeadlineAt: date.toISOString() });
    } else if (state.run?.safetyDeadlineAt && !existingSafety) {
      state = updateRun(state, {}, ["safetyDeadlineAt"]);
    }
    state = updateRun(state, { nextWorkAt: date.toISOString() });
    state = await persist(state);
    if (recoveryRequired(state)) {
      await clearSchedule(INSTAGRAM_FOLLOWUP_NEXT_ALARM);
      return state;
    }
    await schedule(date, INSTAGRAM_FOLLOWUP_NEXT_ALARM, { safety });
    return state;
  }

  async function scheduleAfter(state, minimum, maximum) {
    const milliseconds = randomDelay(random, minimum, maximum);
    return scheduleAt(state, new Date(currentDate().getTime() + milliseconds), { safety: true });
  }

  async function getState() {
    return store.load();
  }

  function isLiveTestCandidate(state, candidate) {
    if (!state.run?.liveTestSourceId) return true;
    return (state.run.liveTestCandidateIds || []).includes(candidate.id);
  }

  function needsFollowBackReview(state, candidate) {
    return isLiveTestCandidate(state, candidate)
      && candidate.status === "followed"
      && candidate.followBackStatus !== "confirmed"
      && candidate.followBackReviewDueAt
      && (!candidate.lastFollowBackCheckAt
        || candidate.lastFollowBackCheckAt < candidate.followBackReviewDueAt);
  }

  function nextFollowBackReviewDate(state, current) {
    const dueDates = state.candidates
      .filter((candidate) => needsFollowBackReview(state, candidate))
      .map(({ followBackReviewDueAt }) => validDate(followBackReviewDueAt, "followBackReviewDueAt"));
    if (!dueDates.length) return null;

    const intrinsic = earliestDate(dueDates);
    const retry = futureRunDate(
      state.run?.nextRelationshipReviewAt,
      current,
      "nextRelationshipReviewAt",
    );
    if (retry && intrinsic <= current) return retry;
    return retry && retry < intrinsic ? retry : intrinsic;
  }

  function hasSourceScanWork(state, now) {
    if (state.run.liveTestSourceId) {
      return state.sources.some((source) => (
        canonicalSourceId(source.id) === canonicalSourceId(state.run.liveTestSourceId)
        && (source.status === "pending" || source.status === "error")
      ));
    }
    if (state.run.sourceScanSourceId) {
      return state.sources.some((source) => (
        canonicalSourceId(source.id) === canonicalSourceId(state.run.sourceScanSourceId)
        && (source.status === "pending" || source.status === "error")
      ));
    }
    return getPendingFollowCount(state) < state.settings.refillThreshold
      && state.sources.some((source) => isSourceScanEligible(source, now, state.settings.sourceRescanHours));
  }

  function ensureBalancedCycle(state, current) {
    if (!balancedCycles || !state.automationEnabled || state.run?.cycle) return state;
    const activeStage = state.run?.activeBatch?.kind;
    return updateRun(state, {
      cycle: {
        dueAt: current.toISOString(),
        stage: activeStage === "follow" || activeStage === "unfollow" ? activeStage : "review",
      },
    });
  }

  function refreshGlobalDeadlines(state, current) {
    state = ensureBalancedCycle(state, current);
    state = scheduleFollowBackReview(state, current);
    const relationshipAt = nextFollowBackReviewDate(state, current);
    if (relationshipAt) {
      state = updateRun(state, { nextRelationshipReviewAt: relationshipAt.toISOString() });
    } else {
      state = updateRun(state, {}, ["nextRelationshipReviewAt"]);
    }

    if (!hasSourceScanWork(state, current)) {
      state = updateRun(state, {}, ["nextSourceScanAt", "sourceScanSourceId"]);
    } else if (state.run.nextSourceScanAt === undefined && state.automationEnabled) {
      state = updateRun(state, { nextSourceScanAt: current.toISOString() });
    }
    return state;
  }

  function futureBalancedCycleDate(state, current) {
    if (!balancedCycles || !state.automationEnabled || state.run?.activeBatch) return null;
    if (state.run?.cycle?.stage !== "review") return null;
    return futureRunDate(state.run.cycle.dueAt, current, "cycle.dueAt");
  }

  function nextGlobalWorkDate(state, current) {
    const futureCycle = futureBalancedCycleDate(state, current);
    if (futureCycle) return futureCycle;
    const next = state.automationEnabled
      ? selectNextWork(state, current)
      : (state.run.nextSourceScanAt && state.run.nextSourceScanAt <= current.toISOString()
        ? { kind: "source_scan" }
        : { kind: "idle" });
    if (next.kind !== "idle") return current;

    const currentIso = current.toISOString();
    const hasDueReviewedUnfollow = state.candidates.some((candidate) => (
      isLiveTestCandidate(state, candidate)
      && candidate.status === "followed"
      && candidate.unfollowDueAt
      && candidate.unfollowDueAt <= currentIso
      && (candidate.followBackStatus === "confirmed"
        || (candidate.followBackReviewDueAt
          && candidate.lastFollowBackCheckAt
          && candidate.lastFollowBackCheckAt >= candidate.followBackReviewDueAt))
    ));
    if (state.automationEnabled && hasDueReviewedUnfollow) return current;

    const futureDates = [];
    if (state.run.nextSourceScanAt) {
      futureDates.push(validDate(state.run.nextSourceScanAt, "nextSourceScanAt"));
    }
    if (state.automationEnabled && state.run.nextRelationshipReviewAt) {
      futureDates.push(validDate(state.run.nextRelationshipReviewAt, "nextRelationshipReviewAt"));
    }
    if (state.automationEnabled) {
      const lifecycleAt = nextDueLifecycleAt(state, current);
      if (lifecycleAt) {
        const lifecycleDate = validDate(lifecycleAt, "next lifecycle work");
        if (lifecycleDate > current) futureDates.push(lifecycleDate);
      }
      const futureUnfollow = earliestFutureUnfollow(state, current);
      if (futureUnfollow) futureDates.push(futureUnfollow);
      const rescanAt = nextSourceRescanDate(state, current);
      if (rescanAt && rescanAt > current) futureDates.push(rescanAt);
    }
    return futureDates.length ? earliestDate(futureDates) : null;
  }

  async function scheduleNextGlobalWork(state, current = currentDate()) {
    state = refreshGlobalDeadlines(state, current);
    const at = nextGlobalWorkDate(state, current);
    if (at) return scheduleAt(state, at);
    state = updateRun(state, {
      phase: state.automationEnabled ? "idle" : state.run.phase,
      activeBatch: state.run.activeBatch || null,
    }, ["nextWorkAt"]);
    return persist(state);
  }

  function fenceActiveExternalWork(state, current) {
    const externalWorkActive = Boolean(state.run?.externalOperation)
      || Boolean(state.run?.inflightAction)
      || ["collecting", "reviewing"].includes(state.run?.phase);
    const revokedLeaseExpiry = externalWorkActive
      ? futureRunDate(state.run?.lease?.expiresAt, current, "lease.expiresAt")
      : null;
    if (!revokedLeaseExpiry) return state;

    const existingSafety = futureRunDate(
      state.run?.safetyDeadlineAt,
      current,
      "safetyDeadlineAt",
    );
    const fenceAt = existingSafety && existingSafety > revokedLeaseExpiry
      ? existingSafety
      : revokedLeaseExpiry;
    return updateRun(state, { safetyDeadlineAt: fenceAt.toISOString() });
  }

  async function startAuto() {
    return enqueue(async () => {
      const result = await withLease(async (current) => {
        const currentDateValue = currentDate();
        const safetyDeadline = futureRunDate(
          current.run?.safetyDeadlineAt,
          currentDateValue,
          "safetyDeadlineAt",
        );
        const at = safetyDeadline || currentDateValue;
        let state = {
          ...current,
          automationEnabled: true,
        };
        state = updateRun(state, {
          phase: state.run.activeBatch ? "running_batch" : (at > currentDateValue ? "waiting" : "idle"),
          ...(balancedCycles && current.settings.cycleIntervalHours > 0
            ? { cycle: current.run?.cycle || { dueAt: at.toISOString(), stage: "review" } }
            : {}),
        }, ["nextWorkAt"]);
        state = refreshGlobalDeadlines(state, currentDateValue);
        return scheduleAt(state, at);
      }, { preemptControlledLease: true, blockRecovery: true });
      return result.acquired ? result.value : result.state;
    });
  }

  async function startLiveTest(sourceId, sourceLimit = 10) {
    return enqueue(async () => {
      const canonicalId = canonicalSourceId(sourceId);
      if (!Number.isInteger(sourceLimit) || sourceLimit <= 0 || sourceLimit > 10) {
        throw new Error("Live tests may process at most ten candidates.");
      }
      const result = await withLease(async (current) => {
        const source = current.sources.find((candidate) => canonicalSourceId(candidate.id) === canonicalId);
        if (!source) throw new Error("Follow-up source was not found.");
        const currentDateValue = currentDate();
        let state = replaceSource(current, source.id, (candidate) => ({
          ...candidate,
          limit: sourceLimit,
          collectionDepth: 0,
          status: "pending",
          updatedAt: currentDateValue.toISOString(),
        }));
        state = { ...state, automationEnabled: true };
        state = updateRun(state, {
          phase: "idle",
          liveTestSourceId: canonicalId,
          liveTestCandidateIds: [],
          nextSourceScanAt: currentDateValue.toISOString(),
          sourceScanSourceId: canonicalId,
        }, ["nextWorkAt", "safetyDeadlineAt"]);
        return scheduleAt(state, currentDateValue);
      }, { preemptControlledLease: true, blockRecovery: true });
      return result.acquired ? result.value : result.state;
    });
  }

  async function pause() {
    activeCollectionController?.abort(new DOMException("Follower collection was paused.", "AbortError"));
    return enqueue(async () => {
      const controlledAt = currentDate();
      const state = await store.update((current) => {
        if (recoveryRequired(current)) return current;
        return updateRun(
          fenceActiveExternalWork(current, controlledAt),
          { phase: "paused" },
          ["lease"],
        );
      });
      await clearSchedule(INSTAGRAM_FOLLOWUP_NEXT_ALARM);
      return state;
    });
  }

  async function resume() {
    return enqueue(async () => {
      const result = await withLease(async (current) => {
        const currentDateValue = currentDate();
        let state = {
          ...current,
          automationEnabled: true,
        };
        state = refreshGlobalDeadlines(state, currentDateValue);
        const selectedAt = nextGlobalWorkDate(state, currentDateValue) || currentDateValue;
        const safetyDeadline = futureRunDate(
          state.run.safetyDeadlineAt,
          currentDateValue,
          "safetyDeadlineAt",
        );
        const at = safetyDeadline && safetyDeadline > selectedAt ? safetyDeadline : selectedAt;
        state = updateRun(state, {
          phase: state.run.activeBatch ? "running_batch" : (at > currentDateValue ? "waiting" : "idle"),
        });
        return scheduleAt(state, at);
      }, { preemptControlledLease: true, blockRecovery: true });
      return result.acquired ? result.value : result.state;
    });
  }

  async function stop({ clearLiveTest = false } = {}) {
    activeCollectionController?.abort(new DOMException("Follower collection was stopped.", "AbortError"));
    return enqueue(async () => {
      const controlledAt = currentDate();
      const state = await store.update((current) => {
        if (recoveryRequired(current)) return current;
        let state = {
          ...fenceActiveExternalWork(current, controlledAt),
          automationEnabled: false,
        };
        state = updateRun(state, { phase: "stopped" }, [
          "nextWorkAt",
          "nextSourceScanAt",
          "sourceScanSourceId",
          "lease",
          ...(clearLiveTest ? ["liveTestSourceId", "liveTestCandidateIds"] : []),
        ]);
        return state;
      });
      await clearSchedule(INSTAGRAM_FOLLOWUP_NEXT_ALARM);
      return state;
    });
  }

  async function stopLiveTest() {
    return stop({ clearLiveTest: true });
  }

  async function saveSettings(changes) {
    return enqueue(async () => {
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        throw new Error("Follow-up settings changes must be an object.");
      }
      const preview = await store.load();
      validateFollowupSettings({ ...preview.settings, ...changes });
      const result = await withLease(async (current) => {
        const settings = { ...current.settings, ...changes };
        validateFollowupSettings(settings);
        const state = { ...current, settings };
        return state.automationEnabled
          ? scheduleNextGlobalWork(state, currentDate())
          : persist(state);
      });
      return result.acquired ? result.value : result.state;
    });
  }

  async function addSource(input, limit) {
    return enqueue(async () => {
      const profileUrl = normalizeSourceInput(input);
      const at = currentDate().toISOString();
      let added;
      const result = await withLease(async () => {
        await store.update((current) => {
          const id = sourceIdentifier(profileUrl);
          const existing = current.sources.find((source) => canonicalSourceId(source.id) === id);
          if (existing) {
            const parsedLimit = Number.parseInt(limit, 10);
            if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
              added = { ...existing };
              return current;
            }
            added = {
              ...existing,
              limit: Math.min(parsedLimit, current.settings.backlogMaximum),
              updatedAt: at,
            };
            return {
              ...current,
              sources: current.sources.map((source) => source.id === existing.id ? added : source),
            };
          }
          const parsedLimit = Number.parseInt(limit, 10);
          const normalizedLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, current.settings.backlogMaximum)
            : current.settings.perSourceLimit;
          added = {
            id,
            profileUrl,
            limit: normalizedLimit,
            status: "pending",
            createdAt: at,
            updatedAt: at,
          };
          return { ...current, sources: [...current.sources, added] };
        });
        return structuredClone(added);
      });
      if (!result.acquired) return undefined;
      return result.value;
    });
  }

  async function removeSource(sourceId) {
    return enqueue(async () => {
      const normalizedSourceId = canonicalSourceId(sourceId);
      const result = await withLease(async () => store.update((current) => ({
        ...current,
        sources: current.sources.filter(({ id }) => canonicalSourceId(id) !== normalizedSourceId),
      })));
      return result.acquired ? result.value : result.state;
    });
  }

  function applyDirectModalOutcome(state, raw, sourceId, completedAt) {
    const normalized = normalizeCandidate(raw, sourceId, completedAt);
    const existing = state.candidates.find(({ normalizedHandle }) => (
      normalizedHandle === normalized.normalizedHandle
    ));
    const candidate = {
      ...(existing || normalized),
      handle: normalized.handle,
      profileUrl: normalized.profileUrl,
      normalizedHandle: normalized.normalizedHandle,
      sourceIds: [...new Set([...(existing?.sourceIds || []), sourceId])],
      updatedAt: completedAt.toISOString(),
    };
    const outcome = raw && ["succeeded", "follow_request_sent", "skipped", "failed"].includes(raw.status)
      ? raw
      : { status: "failed", reason: "Instagram direct follow returned an invalid result." };
    const at = completedAt.toISOString();
    if (["succeeded", "follow_request_sent"].includes(outcome.status)) {
      candidate.status = "followed";
      candidate.followedAt = at;
      candidate.unfollowDueAt = new Date(
        completedAt.getTime() + (state.settings.unfollowDelayDays * 86_400_000),
      ).toISOString();
      delete candidate.nextAction;
      delete candidate.failedAt;
    } else if (
      outcome.status === "skipped"
      && outcome.reason === "already-following"
      && ["followed", "pending_unfollow"].includes(existing?.status)
      && existing.followedAt
      && existing.unfollowDueAt
    ) {
      candidate.status = existing.status;
    } else if (outcome.status === "skipped") {
      candidate.status = "skipped";
      delete candidate.nextAction;
      delete candidate.failedAt;
    } else {
      candidate.status = "failed";
      candidate.failedAt = at;
      candidate.nextAction = "follow";
    }
    const candidates = existing
      ? state.candidates.map((current) => current.id === existing.id ? candidate : current)
      : [...state.candidates, candidate];
    const updatedState = {
      ...state,
      candidates,
      history: [...(state.history || []), terminalHistory(candidate, "follow", outcome, at)],
    };
    const directFollowSucceeded = ["succeeded", "follow_request_sent"].includes(outcome.status);
    const alreadyInLiveTest = updatedState.run?.liveTestCandidateIds?.includes(candidate.id);
    if (updatedState.run?.liveTestSourceId === sourceId && (directFollowSucceeded || alreadyInLiveTest)) {
      updatedState.run = {
        ...updatedState.run,
        liveTestCandidateIds: [...new Set([
          ...(updatedState.run.liveTestCandidateIds || []),
          candidate.id,
        ])].slice(0, 10),
      };
    }
    return directFollowSucceeded
      ? scheduleFollowBackReview(updatedState, completedAt)
      : updatedState;
  }

  function waitForDelay(milliseconds, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(finish, milliseconds);
      const onAbort = () => finish(signal.reason, true);
      function finish(value, aborted = false) {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        if (aborted) reject(value);
        else resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function abortCollectionIfRecoveryRequired(state, controller) {
    if (!recoveryRequired(state)) return;
    const reason = new DOMException(
      "Follower collection stopped because manual recovery is required.",
      "AbortError",
    );
    controller.abort(reason);
    throw reason;
  }

  async function collectSource(state, source, limit) {
    const rescan = isPreviouslyCollectedSource(source);
    const startedAt = currentDate();
    state = replaceSource(state, source.id, (current) => ({
      ...current,
      status: "collecting",
      updatedAt: startedAt.toISOString(),
    }));
    state = updateRun(state, { phase: "collecting" }, ["nextWorkAt"]);
    const marked = markExternalOperation(state, "source_collection", source.id);
    state = marked.state;
    state = await persistExternalOperation(state);

    try {
      const controller = new AbortController();
      activeCollectionController = controller;
      let result;
      try {
        if (collectAndFollowFollowers && !rescan && !state.run.cycle) {
          result = await collectAndFollowFollowers({
            profileUrl: source.profileUrl,
            limit,
            signal: controller.signal,
            onOutcome: async (outcome) => {
              state = applyDirectModalOutcome(state, outcome, source.id, currentDate());
              state = await scheduleAfter(
                state,
                state.settings.actionDelayMinSeconds * 1_000,
                state.settings.actionDelayMaxSeconds * 1_000,
              );
              abortCollectionIfRecoveryRequired(state, controller);
              const deadline = validDate(state.run.nextWorkAt, "nextWorkAt");
              await waitForDelay(Math.max(0, deadline.getTime() - currentDate().getTime()), controller.signal);
              state = updateRun(state, {}, ["nextWorkAt", "safetyDeadlineAt"]);
              state = await persist(state);
              abortCollectionIfRecoveryRequired(state, controller);
            },
          });
        } else {
          result = await collectFollowers({ profileUrl: source.profileUrl, limit, signal: controller.signal });
        }
      } finally {
        activeCollectionController = null;
        state = updateRun(state, {}, ["externalOperation"]);
        await acknowledgeExternalOperation(marked.operation);
      }
      const completedAt = currentDate();
      const collectedCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
      state = mergeCollectedCandidates(
        state,
        collectedCandidates,
        source.id,
        completedAt,
        state.settings.backlogMaximum,
      );
      state = replaceSource(state, source.id, (current) => {
        const configuredLimit = current.limit || state.settings.perSourceLimit;
        const previousDepth = Number.isInteger(current.collectionDepth) && current.collectionDepth > 0
          ? current.collectionDepth
          : 0;
        const processedCount = Number.isInteger(result?.processedCount)
          ? result.processedCount
          : collectedCandidates.length;
        const collectionDepth = Math.min(
          configuredLimit,
          Math.max(previousDepth, Math.min(limit, processedCount)),
        );
        const warned = typeof result?.warning === "string" && Boolean(result.warning);
        const updated = {
          ...current,
          status: rescan || warned || processedCount < limit || limit >= configuredLimit
            ? "completed"
            : "pending",
          collectionDepth,
          updatedAt: completedAt.toISOString(),
          lastCollectedAt: completedAt.toISOString(),
        };
        if (warned) updated.warning = result.warning;
        else delete updated.warning;
        return updated;
      });
      state = await persist(state);
      return { state, error: null };
    } catch (error) {
      activeCollectionController = null;
      const failedAt = currentDate().toISOString();
      state = replaceSource(state, source.id, (current) => ({
        ...current,
        status: "error",
        warning: `Retryable source error: ${errorMessage(error)}`,
        updatedAt: failedAt,
      }));
      state = await persist(state);
      return { state, error };
    }
  }

  async function refillSources(state, { sourceId } = {}) {
    if (sourceId) {
      const source = state.sources.find((candidate) => canonicalSourceId(candidate.id) === sourceId);
      const remaining = state.settings.backlogMaximum - getPendingFollowCount(state);
      if (!source || remaining <= 0) return { state, hadError: false };
      const result = await collectSource(
        state,
        source,
        sourceScanLimit(state, source, remaining),
      );
      return { state: result.state, hadError: Boolean(result.error) };
    }

    if (getPendingFollowCount(state) >= state.settings.refillThreshold) {
      return { state, hadError: false };
    }

    const attempted = new Set();
    let hadError = false;
    while (getPendingFollowCount(state) < state.settings.backlogMaximum) {
      const source = nextAutomaticSource(state.sources, attempted, currentDate(), state.settings.sourceRescanHours);
      if (!source) break;
      attempted.add(source.id);
      const remaining = state.settings.backlogMaximum - getPendingFollowCount(state);
      const limit = sourceScanLimit(state, source, remaining);
      const result = await collectSource(state, source, limit);
      state = result.state;
      hadError ||= Boolean(result.error);
      if (recoveryRequired(state)) break;
    }
    return { state, hadError };
  }

  function recoverInterruptedCollection(state, at) {
    const interrupted = state.sources.some(({ status }) => status === "collecting");
    if (!interrupted && state.run.phase !== "collecting") return state;
    const iso = at.toISOString();
    state = {
      ...state,
      sources: state.sources.map((source) => source.status === "collecting" ? {
        ...source,
        status: "pending",
        warning: "Previous collection was interrupted and will be retried.",
        updatedAt: iso,
      } : source),
    };
    return updateRun(state, { phase: state.run.activeBatch ? "running_batch" : "idle" });
  }

  function promoteDueUnfollows(state, at) {
    const iso = at.toISOString();
    return {
      ...state,
      candidates: state.candidates.map((candidate) => (
        isLiveTestCandidate(state, candidate)
          && candidate.status === "followed"
          && candidate.unfollowDueAt
          && candidate.unfollowDueAt <= iso
          && (candidate.followBackStatus === "confirmed"
            || (candidate.followBackReviewDueAt
              && candidate.lastFollowBackCheckAt
              && candidate.lastFollowBackCheckAt >= candidate.followBackReviewDueAt))
          ? { ...candidate, status: "pending_unfollow", updatedAt: iso }
          : candidate
      )),
    };
  }

  async function reviewFollowBacks(state, { cycle = false } = {}) {
    state = updateRun(state, { phase: "reviewing" }, ["nextWorkAt"]);
    const marked = markExternalOperation(state, "relationship_review", "own-followers");
    state = marked.state;
    state = await persistExternalOperation(state);

    try {
      const controller = new AbortController();
      activeCollectionController = controller;
      let result;
      try {
        result = await collectOwnFollowerHandles({
          limit: state.settings.backlogMaximum,
          signal: controller.signal,
        });
      } finally {
        activeCollectionController = null;
        state = updateRun(state, {}, ["externalOperation"]);
        await acknowledgeExternalOperation(marked.operation);
      }
      if (!result || !Array.isArray(result.handles)) {
        throw new Error("Instagram follow-back review returned no handle list.");
      }
      if (result.warning !== null && result.warning !== undefined) {
        const retryAt = new Date(
          currentDate().getTime() + randomDelay(
            random,
            state.settings.batchDelayMinMinutes * 60_000,
            state.settings.batchDelayMaxMinutes * 60_000,
          ),
        );
        state = updateRun(state, {
          phase: "waiting",
          nextRelationshipReviewAt: retryAt.toISOString(),
        });
        state = await persist(state);
        return scheduleNextGlobalWork(state, currentDate());
      }

      const completedAt = currentDate();
      state = applyFollowBackReview(state, result.handles, completedAt);
      state = updateRun(state, { phase: "idle" }, ["nextRelationshipReviewAt"]);
      if (cycle) {
        state = promoteDueUnfollows(state, completedAt);
        state = updateRun(state, { cycle: { ...state.run.cycle, stage: "collect" } });
      }
      state = await persist(state);
      if (cycle) return startBalancedCollection(state, completedAt);
      return scheduleNextGlobalWork(state, completedAt);
    } catch (error) {
      activeCollectionController = null;
      const retryAt = new Date(
        currentDate().getTime() + randomDelay(
          random,
          state.settings.batchDelayMinMinutes * 60_000,
          state.settings.batchDelayMaxMinutes * 60_000,
        ),
      );
      state = updateRun(state, {
        phase: "waiting",
        nextRelationshipReviewAt: retryAt.toISOString(),
      });
      state = await persist(state);
      return scheduleNextGlobalWork(state, currentDate());
    }
  }

  function cycleHasFollowedCandidates(state) {
    return state.candidates.some((candidate) => candidate.status === "followed" || candidate.status === "pending_unfollow");
  }

  function nextBalancedCycleSource(state) {
    const balancedRotationTimestamp = (source) => {
      const timestamp = Date.parse(source.lastCollectedAt);
      return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
    };
    return [...state.sources]
      .filter(({ status }) => status !== "collecting")
      .sort((first, second) => balancedRotationTimestamp(first) - balancedRotationTimestamp(second))[0] || null;
  }

  async function startBalancedCollection(state, at = currentDate()) {
    const requestedSourceId = state.run?.sourceScanSourceId;
    const source = requestedSourceId
      ? state.sources.find((candidate) => canonicalSourceId(candidate.id) === canonicalSourceId(requestedSourceId))
      : nextBalancedCycleSource(state);
    if (!source) {
      state = updateRun(state, { cycle: { ...state.run.cycle, stage: "unfollow" } });
      return beginCycleActions(state, at);
    }
    state = updateRun(state, {
      phase: "waiting",
      cycle: { ...state.run.cycle, stage: "collect" },
      nextSourceScanAt: at.toISOString(),
      sourceScanSourceId: source.id,
    }, ["nextWorkAt"]);
    state = await persist(state);
    return runSourceCycle(state);
  }

  async function finishCycle(state) {
    const nextCycleAt = new Date(currentDate().getTime() + (state.settings.cycleIntervalHours * 3_600_000));
    state = updateRun(state, {
      phase: "waiting",
      activeBatch: null,
      cycle: { dueAt: nextCycleAt.toISOString(), stage: "review" },
    }, ["nextWorkAt"]);
    return scheduleAt(state, nextCycleAt);
  }

  async function beginCycleActions(state, at = currentDate()) {
    let batch = selectNextBatch(state, at);
    if (state.run.cycle?.stage === "unfollow" && batch?.kind !== "unfollow") {
      state = updateRun(state, { cycle: { ...state.run.cycle, stage: "follow" } });
      batch = countActiveFollows(state) < state.settings.activeFollowCap ? selectNextBatch(state, at) : null;
    }
    if (batch?.kind === "follow" && countActiveFollows(state) >= state.settings.activeFollowCap) return finishCycle(state);
    if (!batch && state.run.cycle) return finishCycle(state);
    if (!batch && hasSourceScanWork(state, at)) return runSourceCycle(state);
    if (!batch) return finishCycle(state);
    state = updateRun(state, { phase: "running_batch", activeBatch: batch }, ["nextWorkAt"]);
    state = await persist(state);
    return processActiveAction(state);
  }

  function terminalHistory(candidate, action, outcome, at) {
    return {
      candidateId: candidate.id,
      action,
      kind: action,
      handle: candidate.handle,
      sourceIds: [...(candidate.sourceIds || [])],
      status: outcome.status,
      reason: typeof outcome.reason === "string" && outcome.reason ? outcome.reason : null,
      timestamp: at,
      at,
    };
  }

  function startupWorkDate(state, current) {
    const candidates = [
      nextGlobalWorkDate(state, current),
      futureRunDate(state.run?.nextWorkAt, current, "nextWorkAt"),
    ].filter(Boolean);
    let at = candidates.length ? earliestDate(candidates) : null;
    const safety = futureRunDate(state.run?.safetyDeadlineAt, current, "safetyDeadlineAt");
    if (safety && (!at || safety > at)) at = safety;
    return at;
  }

  async function processActiveAction(state) {
    const batch = state.run.activeBatch;
    const candidateId = batch?.candidateIds?.[0];
    if (!batch || !candidateId) {
      state = updateRun(state, { phase: "waiting", activeBatch: null }, ["nextWorkAt"]);
      return scheduleAfter(
        state,
        state.settings.batchDelayMinMinutes * 60_000,
        state.settings.batchDelayMaxMinutes * 60_000,
      );
    }

    const candidate = candidateById(state, candidateId);
    if (!candidate) {
      state = updateRun(state, {
        phase: "running_batch",
        activeBatch: { ...batch, candidateIds: batch.candidateIds.slice(1) },
      });
      return processActiveAction(state);
    }

    const action = batch.kind;
    let intent = state.run.inflightAction;
    const recoveringPersistedIntent = actionIntentMatches(intent, candidate, action);
    if (!recoveringPersistedIntent) {
      const attemptedAt = currentDate().toISOString();
      intent = actionIntent(candidate, action, attemptedAt);
      state = replaceCandidate(state, candidate.id, (current) => ({
        ...current,
        status: expectedInflightStatus(action),
        updatedAt: attemptedAt,
      }));
    }
    state = updateRun(state, {
      phase: "running_batch",
      inflightAction: intent,
    }, ["nextWorkAt"]);
    const marked = markExternalOperation(state, "action", intent.id);
    state = marked.state;
    state = await persistExternalOperation(state);

    let outcome;
    try {
      outcome = await performAction({
        expectedHandle: candidate.handle,
        action,
        profileUrl: candidate.profileUrl,
        sourceIds: [...(candidate.sourceIds || [])],
        actionContext: {
          intentId: intent.id,
          candidateId: candidate.id,
          expectedHandle: candidate.handle,
          action,
          recoveringPersistedIntent,
        },
      });
    } catch (error) {
      outcome = { status: "failed", reason: errorMessage(error) };
    } finally {
      state = updateRun(state, {}, ["externalOperation"]);
      await acknowledgeExternalOperation(marked.operation);
    }
    if (!outcome || !["succeeded", "follow_request_sent", "skipped", "failed"].includes(outcome.status)) {
      outcome = { status: "failed", reason: "Instagram action returned an invalid result." };
    }
    if (
      outcome.status === "skipped"
      && outcome.code === "already_desired"
      && recoveringPersistedIntent
      && outcome.intentId === intent.id
    ) {
      outcome = {
        status: "succeeded",
        recovered: true,
        reason: `Recovered interrupted ${action}: Instagram already showed the desired relationship state.`,
      };
    }
    if (
      outcome.status === "skipped"
      && outcome.code === "already_desired"
      && action === "unfollow"
    ) {
      outcome = {
        status: "succeeded",
        reason: "Instagram already showed the desired unfollow state.",
      };
    }

    const completedAt = currentDate();
    const at = completedAt.toISOString();
    state = updateRun(state, {}, ["inflightAction"]);
    state = replaceCandidate(state, candidate.id, (current) => {
      const updated = { ...current, updatedAt: at };
      if (["succeeded", "follow_request_sent"].includes(outcome.status) && action === "follow") {
        updated.status = "followed";
        updated.followedAt = at;
        updated.unfollowDueAt = new Date(
          completedAt.getTime() + (state.settings.unfollowDelayDays * 86_400_000),
        ).toISOString();
        delete updated.nextAction;
        delete updated.failedAt;
      } else if (outcome.status === "succeeded") {
        updated.status = "unfollowed";
        updated.unfollowedAt = at;
        delete updated.nextAction;
        delete updated.failedAt;
      } else if (outcome.status === "skipped") {
        updated.status = "skipped";
        delete updated.nextAction;
        delete updated.failedAt;
      } else {
        updated.status = "skipped";
        updated.failedAt = at;
        delete updated.nextAction;
      }
      return updated;
    });
    state = {
      ...state,
      history: [...(state.history || []), terminalHistory(candidate, action, outcome, at)],
    };
    if (["succeeded", "follow_request_sent"].includes(outcome.status) && action === "follow") {
      state = scheduleFollowBackReview(state, completedAt);
    }

    const remainingIds = batch.candidateIds.slice(1);
    if (remainingIds.length) {
      state = updateRun(state, {
        phase: "running_batch",
        activeBatch: { ...batch, candidateIds: remainingIds },
      }, ["nextWorkAt"]);
      return scheduleAfter(
        state,
        state.settings.actionDelayMinSeconds * 1_000,
        state.settings.actionDelayMaxSeconds * 1_000,
      );
    }

    if (state.run.cycle) {
      if (action === "unfollow" && state.run.cycle.stage === "unfollow") {
        state = updateRun(state, { cycle: { ...state.run.cycle, stage: "follow" }, activeBatch: null });
        return beginCycleActions(state);
      }
      return finishCycle(state);
    }
    state = updateRun(state, { phase: "waiting", activeBatch: null }, ["nextWorkAt"]);
    return scheduleAfter(
      state,
      state.settings.batchDelayMinMinutes * 60_000,
      state.settings.batchDelayMaxMinutes * 60_000,
    );
  }

  async function runSourceCycle(state) {
    const previousPhase = state.run.phase;
    const requestedSourceId = state.run.sourceScanSourceId;
    const balancedCollection = state.run.cycle?.stage === "collect";
    const refill = await refillSources(state, { sourceId: requestedSourceId });
    state = refill.state;
    if (recoveryRequired(state)) return state;
    state = updateRun(state, {}, ["nextSourceScanAt", "sourceScanSourceId"]);
    if (refill.hadError) {
      const retryAt = new Date(
        currentDate().getTime() + randomDelay(
          random,
          state.settings.batchDelayMinMinutes * 60_000,
          state.settings.batchDelayMaxMinutes * 60_000,
        ),
      );
      state = updateRun(state, {
        nextSourceScanAt: retryAt.toISOString(),
        ...(requestedSourceId ? { sourceScanSourceId: requestedSourceId } : {}),
      });
    }

    if (balancedCollection) {
      if (refill.hadError) {
        state = updateRun(state, { phase: "waiting", activeBatch: null }, ["nextWorkAt"]);
        return scheduleNextGlobalWork(state, currentDate());
      }
      state = updateRun(state, { cycle: { ...state.run.cycle, stage: "unfollow" } });
      state = await persist(state);
      return beginCycleActions(state, currentDate());
    }

    const batch = state.automationEnabled ? selectNextBatch(state, currentDate()) : null;
    if (batch && (batch.kind === "unfollow" || !collectAndFollowFollowers || state.run.cycle)) {
      state = updateRun(state, { phase: "running_batch", activeBatch: batch });
      state = await persist(state);
      return processActiveAction(state);
    }

    state = updateRun(state, {
      phase: refill.hadError ? "waiting" : (state.automationEnabled ? "idle" : previousPhase),
      activeBatch: null,
    }, ["nextWorkAt"]);
    return scheduleNextGlobalWork(state, currentDate());
  }

  async function runDueWork() {
    return enqueue(async () => {
      let initial = await store.load();
      if (initial.run.phase === "recovery_required") {
        initial = await skipInterruptedOperation(initial);
      }
      const manualSourceScanQueued = Boolean(
        initial.run.nextSourceScanAt && initial.run.sourceScanSourceId,
      );
      if (initial.run.phase === "paused"
        || (!initial.automationEnabled && !manualSourceScanQueued)
        || (initial.run.phase === "stopped" && !manualSourceScanQueued)) {
        return initial;
      }

      const leased = await withLease(async (claimed) => {
        const current = currentDate();
        let state = claimed;
        if (!PHASES.has(state.run.phase)) state = updateRun(state, { phase: "idle" });
        state = recoverInterruptedCollection(state, current);
        state = reconcileInterruptedActionState(state, current);
        state = recoverPersistedInflightIntent(state, current);

        const futureDeadlines = [
          futureRunDate(state.run.nextWorkAt, current, "nextWorkAt"),
          futureRunDate(state.run.safetyDeadlineAt, current, "safetyDeadlineAt"),
        ].filter(Boolean);
        if (futureDeadlines.length) {
          return scheduleAt(state, latestDate(futureDeadlines));
        }
        state = updateRun(state, {}, ["nextWorkAt", "safetyDeadlineAt"]);

        state = refreshGlobalDeadlines(state, current);
        state = promoteDueUnfollows(state, current);
        state = await persist(state);

        const futureCycle = futureBalancedCycleDate(state, current);
        if (futureCycle && !state.run.sourceScanSourceId) return scheduleAt(state, futureCycle);

        if (state.automationEnabled && state.run.cycle?.stage === "collect") {
          const sourceDue = !state.run.nextSourceScanAt
            || state.run.nextSourceScanAt <= current.toISOString();
          return sourceDue ? startBalancedCollection(state, current) : scheduleNextGlobalWork(state, current);
        }

        if (state.automationEnabled && state.run.cycle?.dueAt <= current.toISOString()
          && state.run.cycle.stage === "review") {
          if (cycleHasFollowedCandidates(state)) return reviewFollowBacks(state, { cycle: true });
          return startBalancedCollection(state, current);
        }

        if (!state.automationEnabled) {
          const sourceDue = state.run.nextSourceScanAt
            && state.run.nextSourceScanAt <= current.toISOString();
          return sourceDue ? runSourceCycle(state) : scheduleNextGlobalWork(state, current);
        }

        const next = selectNextWork(state, current);
        if (next.kind === "action") {
          if (!state.run.activeBatch) {
            state = updateRun(state, { phase: "running_batch", activeBatch: next.batch });
          }
          state = await persist(state);
          return processActiveAction(state);
        }
        if (next.kind === "relationship_review") return reviewFollowBacks(state);
        if (next.kind === "source_scan") return runSourceCycle(state);
        return scheduleNextGlobalWork(state, current);
      }, { blockRecovery: true });

      return leased.acquired ? leased.value : leased.state;
    });
  }

  async function skipInterruptedOperation(initial) {
    const interruptedOperation = initial.run?.externalOperation;
    if (!interruptedOperation && !initial.run?.inflightAction && initial.run?.phase !== "recovery_required") return initial;
    const completedAt = currentDate();
    const at = completedAt.toISOString();
    return store.update((current) => {
      if (interruptedOperation
        && !operationMatches(current.run?.externalOperation, interruptedOperation)) return current;
      if (!interruptedOperation
        && !current.run?.inflightAction
        && current.run?.phase !== "recovery_required") return current;

      const intent = current.run?.inflightAction;
      const batch = current.run?.activeBatch;
      const action = intent?.action || batch?.kind;
      const candidateId = intent?.candidateId || batch?.candidateIds?.[0];
      const candidate = candidateId ? candidateById(current, candidateId) : null;
      const remainingIds = candidateId && batch?.candidateIds
        ? batch.candidateIds.filter((id) => id !== candidateId)
        : [];
      let state = current;
      if (candidate && (action === "follow" || action === "unfollow")) {
        const reason = `Skipped automatically after an interrupted ${action} action.`;
        state = replaceCandidate(state, candidate.id, (existing) => {
          const updated = { ...existing, status: "skipped", failedAt: at, updatedAt: at };
          delete updated.nextAction;
          return updated;
        });
        state = {
          ...state,
          history: [...(state.history || []), terminalHistory(candidate, action, {
            status: "failed",
            reason,
          }, at)],
        };
      }

      const resumeAt = remainingIds.length
        ? new Date(completedAt.getTime() + 6_000).toISOString()
        : null;
      return updateRun(state, {
        phase: remainingIds.length ? "running_batch" : (state.automationEnabled ? "idle" : "stopped"),
        activeBatch: remainingIds.length ? { ...batch, candidateIds: remainingIds } : null,
        ...(resumeAt ? { nextWorkAt: resumeAt, safetyDeadlineAt: resumeAt } : {}),
      }, [
        "externalOperation",
        "inflightAction",
        "lease",
        ...(resumeAt ? [] : ["nextWorkAt", "safetyDeadlineAt"]),
      ]);
    });
  }

  async function resolveInterruptedOperation() {
    return enqueue(async () => {
      const initial = await store.load();
      const state = await skipInterruptedOperation(initial);
      if (!state.automationEnabled || state.run.phase === "paused" || state.run.phase === "stopped") return state;
      return scheduleNextGlobalWork(state);
    });
  }

  async function reconcileStartup({ serviceWorkerActivated = false } = {}) {
    return enqueue(async () => {
      let initial = await store.load();
      if (serviceWorkerActivated || initial.run.phase === "recovery_required") {
        initial = await skipInterruptedOperation(initial);
      }
      initial = await store.update((current) => ensureBalancedCycle(current, currentDate()));
      const explicitSourceScanQueued = Boolean(
        initial.run.nextSourceScanAt && initial.run.sourceScanSourceId,
      );
      if (initial.run.phase === "paused"
        || ((!initial.automationEnabled || initial.run.phase === "stopped")
          && !explicitSourceScanQueued)) {
        await clearSchedule(INSTAGRAM_FOLLOWUP_NEXT_ALARM);
        return initial;
      }

      const leased = await withLease(async (claimed) => {
        const current = currentDate();
        let state = claimed;
        if (!PHASES.has(state.run.phase)) state = updateRun(state, { phase: "idle" });
        state = recoverInterruptedCollection(state, current);
        state = reconcileInterruptedActionState(state, current);
        state = recoverPersistedInflightIntent(state, current);
        if (!state.run.activeBatch && ["running_batch", "blocked"].includes(state.run.phase)) {
          state = updateRun(state, { phase: "idle" });
        }
        state = refreshGlobalDeadlines(state, current);

        const at = startupWorkDate(state, current);
        if (at) return scheduleAt(state, at);

        state = updateRun(state, { phase: "idle", activeBatch: null }, ["nextWorkAt"]);
        state = await persist(state);
        await clearSchedule(INSTAGRAM_FOLLOWUP_NEXT_ALARM);
        return state;
      }, { blockRecovery: true });
      return leased.acquired ? leased.value : leased.state;
    });
  }

  async function scanNow(sourceId) {
    return enqueue(async () => {
      const queuedAt = currentDate();
      const state = await store.update((current) => {
        if (recoveryRequired(current)) return current;
        const canonicalId = canonicalSourceId(sourceId);
        const source = current.sources.find((candidate) => canonicalSourceId(candidate.id) === canonicalId);
        if (!source) throw new Error("Follow-up source was not found.");
        let updated = replaceSource(current, source.id, (candidate) => ({
          ...candidate,
          status: "pending",
          updatedAt: queuedAt.toISOString(),
        }));

        const barriers = [
          futureRunDate(current.run.safetyDeadlineAt, queuedAt, "safetyDeadlineAt"),
          futureRunDate(current.run.lease?.expiresAt, queuedAt, "lease.expiresAt"),
          current.run.activeBatch
            ? futureRunDate(current.run.nextWorkAt, queuedAt, "nextWorkAt")
            : null,
        ].filter(Boolean);
        const nextWorkAt = barriers.length ? latestDate(barriers) : queuedAt;
        updated = updateRun(updated, {
          nextSourceScanAt: queuedAt.toISOString(),
          sourceScanSourceId: canonicalId,
          nextWorkAt: nextWorkAt.toISOString(),
        });
        return updated;
      });
      if (recoveryRequired(state)) return state;
      if (state.run.phase !== "paused") {
        await schedule(validDate(state.run.nextWorkAt, "nextWorkAt"), INSTAGRAM_FOLLOWUP_NEXT_ALARM, { safety: true });
      }
      return state;
    });
  }

  async function runManualSource(sourceId) {
    return scanNow(sourceId);
  }

  async function runFollowBackReview() {
    return enqueue(async () => {
      const initial = await store.load();
      if (recoveryRequired(initial)) return initial;
      const leased = await withLease(async (claimed) => {
        if (recoveryRequired(claimed)) return claimed;
        return reviewFollowBacks(refreshGlobalDeadlines(claimed, currentDate()));
      }, { blockRecovery: true });
      return leased.acquired ? leased.value : leased.state;
    });
  }

  async function runNextCycleNow() {
    return enqueue(async () => {
      const initial = await store.load();
      if (recoveryRequired(initial)) return initial;
      const leased = await withLease(async (claimed) => {
        const current = currentDate();
        const cycle = claimed.run?.cycle;
        if (!claimed.automationEnabled
          || !balancedCycles
          || claimed.run?.activeBatch
          || cycle?.stage !== "review") return claimed;

        const safetyDeadline = futureRunDate(
          claimed.run?.safetyDeadlineAt,
          current,
          "safetyDeadlineAt",
        );
        const at = safetyDeadline || current;
        const state = updateRun(claimed, {
          phase: at > current ? "waiting" : "idle",
          cycle: { ...cycle, dueAt: current.toISOString(), stage: "review" },
        });
        return scheduleAt(state, at);
      }, { blockRecovery: true });
      return leased.acquired ? leased.value : leased.state;
    });
  }

  return {
    startAuto,
    startLiveTest,
    pause,
    resume,
    stop,
    stopLiveTest,
    addSource,
    removeSource,
    scanNow,
    runManualSource,
    runFollowBackReview,
    runNextCycleNow,
    saveSettings,
    getState,
    runDueWork,
    resolveInterruptedOperation,
    reconcileStartup,
  };
}

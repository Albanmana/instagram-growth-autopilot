import { test } from "node:test";
import assert from "node:assert/strict";
import * as followupModel from "../extension/followup-model.js";
import {
  DEFAULT_FOLLOWUP_SETTINGS,
  applyActionOutcome,
  applyFollowBackReview,
  buildLocalExport,
  countActiveFollows,
  getDueUnfollowCandidates,
  getPendingFollowCount,
  mergeCandidates,
  normalizeCandidate,
  normalizeSourceInput,
  selectNextBatch,
} from "../extension/followup-model.js";

const NOW = new Date("2026-08-13T01:00:00.000Z");

function withFollowedCandidate(handle, fields = {}) {
  const normalizedHandle = handle.toLowerCase();
  return {
    version: 1,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [],
    candidates: [{
      id: `instagram:${normalizedHandle}`,
      handle,
      normalizedHandle,
      sourceIds: ["source-a"],
      status: "followed",
      createdAt: "2026-08-12T01:00:00.000Z",
      updatedAt: "2026-08-12T01:00:00.000Z",
      followedAt: "2026-08-12T01:00:00.000Z",
      unfollowDueAt: "2026-08-16T01:00:00.000Z",
      ...fields,
    }],
    run: { phase: "idle", activeBatch: null },
    history: [],
  };
}

test("normalizes a profile handle and canonical Instagram profile URL", () => {
  assert.equal(normalizeSourceInput(" @Alice.Example "), "https://www.instagram.com/alice.example/");
  assert.equal(normalizeSourceInput("https://instagram.com/Alice.Example/?utm_source=test"), "https://www.instagram.com/alice.example/");
  assert.throws(() => normalizeSourceInput("https://instagram.com/p/abc/"), /profile/i);
  assert.throws(() => normalizeSourceInput("https://instagram.com/explore/"), /profile/i);
  assert.throws(() => normalizeSourceInput("alice/example"), /profile/i);
});

test("defaults to four-hour balanced batches and counts the active follow stock", () => {
  assert.equal(DEFAULT_FOLLOWUP_SETTINGS.cycleIntervalHours, 4);
  assert.equal(DEFAULT_FOLLOWUP_SETTINGS.activeFollowCap, 1000);
  const state = {
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    run: { phase: "idle", activeBatch: null },
    candidates: [
      { ...normalizeCandidate({ handle: "pending" }, "source-a", NOW), status: "pending_follow" },
      { ...normalizeCandidate({ handle: "followed" }, "source-a", NOW), status: "followed" },
      { ...normalizeCandidate({ handle: "due" }, "source-a", NOW), status: "pending_unfollow" },
      { ...normalizeCandidate({ handle: "inflight" }, "source-a", NOW), status: "unfollowing" },
      { ...normalizeCandidate({ handle: "done" }, "source-a", NOW), status: "unfollowed" },
    ],
  };

  assert.equal(countActiveFollows(state), 3);
});

test("a completed review makes an observed follow-back eligible immediately", () => {
  const state = withFollowedCandidate("alice", {
    followedAt: "2026-08-12T01:00:00.000Z",
    unfollowDueAt: "2026-08-14T01:00:00.000Z",
    followBackReviewDueAt: "2026-08-14T01:00:00.000Z",
  });
  const reviewedAt = new Date("2026-08-13T05:00:00.000Z");

  const result = applyFollowBackReview(state, ["alice"], reviewedAt);

  assert.equal(result.candidates[0].followBackStatus, "confirmed");
  assert.equal(result.candidates[0].unfollowDueAt, "2026-08-13T05:00:00.000Z");
});

test("creates a canonical candidate with ISO dates and a normalized dedupe key", () => {
  const candidate = normalizeCandidate({ handle: " Alice.Example " }, "source-a", NOW);

  assert.deepEqual(candidate, {
    id: "instagram:alice.example",
    handle: "Alice.Example",
    profileUrl: "https://www.instagram.com/alice.example/",
    normalizedHandle: "alice.example",
    sourceIds: ["source-a"],
    status: "pending_follow",
    createdAt: "2026-08-13T01:00:00.000Z",
    updatedAt: "2026-08-13T01:00:00.000Z",
  });
});

test("rejects duplicate source IDs without case-sensitive escape hatches", () => {
  assert.throws(() => buildLocalExport({
    version: 1,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [
      { id: "legacy-source", profileUrl: "https://www.instagram.com/alice/" },
      { id: "LEGACY-SOURCE", profileUrl: "https://www.instagram.com/bob/" },
    ],
    candidates: [],
    run: { phase: "idle", activeBatch: null },
    history: [],
  }), /source.*unique/i);
});

test("deduplicates candidates globally and keeps every source", () => {
  const merged = mergeCandidates([], [
    { handle: "alice", sourceId: "source-a" },
    { handle: "Alice", sourceId: "source-b" },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sourceIds, ["source-a", "source-b"]);
  assert.equal(merged[0].status, "pending_follow");
});

test("preserves existing progress when a candidate is seen from a new source", () => {
  const existing = [{
    id: "instagram:alice",
    handle: "alice",
    profileUrl: "https://www.instagram.com/alice/",
    normalizedHandle: "alice",
    sourceIds: ["source-a"],
    status: "followed",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  }];

  const merged = mergeCandidates(existing, [{ handle: "ALICE", sourceId: "source-b" }]);

  assert.equal(merged[0].status, "followed");
  assert.deepEqual(merged[0].sourceIds, ["source-a", "source-b"]);
});

test("collapses pre-existing duplicates without losing a nonterminal candidate state", () => {
  const merged = mergeCandidates([
    { id: "old", handle: "ALICE", sourceIds: ["source-a"], status: "unfollowed" },
    { id: "active", handle: "alice", sourceIds: ["source-b"], status: "pending_unfollow", unfollowDueAt: "2026-08-12T00:00:00.000Z" },
  ], []);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "active");
  assert.equal(merged[0].status, "pending_unfollow");
  assert.deepEqual(merged[0].sourceIds, ["source-a", "source-b"]);
});

test("keeps a due pending unfollow when a duplicate still says following", () => {
  const candidates = mergeCandidates([
    { id: "stale-follow", handle: "alice", sourceIds: ["source-a"], status: "following" },
    { id: "due-unfollow", handle: "ALICE", sourceIds: ["source-b"], status: "pending_unfollow", unfollowDueAt: "2026-08-13T00:00:00.000Z" },
  ], []);
  const state = {
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    run: { phase: "idle", activeBatch: null },
    candidates,
  };

  assert.deepEqual(selectNextBatch(state, NOW), { kind: "unfollow", candidateIds: ["due-unfollow"] });
});

test("counts pending follows and selects due unfollows before follow batches", () => {
  const state = {
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS, batchSize: 1 },
    run: { phase: "idle", activeBatch: null },
    candidates: [
      { id: "a", handle: "alice", status: "pending_unfollow", unfollowDueAt: "2026-08-13T00:00:00.000Z" },
      { id: "b", handle: "bob", status: "pending_follow" },
      { id: "c", handle: "chris", status: "pending_follow" },
    ],
  };

  assert.equal(getPendingFollowCount(state), 2);
  assert.deepEqual(getDueUnfollowCandidates(state, NOW).map(({ id }) => id), ["a"]);
  assert.deepEqual(selectNextBatch(state, NOW), { kind: "unfollow", candidateIds: ["a"] });
});

test("a live test source isolates batch selection from existing pending candidates", () => {
  const state = {
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    candidates: [
      { id: "instagram:old", handle: "old", status: "pending_follow", sourceIds: ["instagram-source:old"] },
      { id: "instagram:test", handle: "test", status: "pending_follow", sourceIds: ["instagram-source:test"] },
    ],
    run: {
      phase: "idle",
      activeBatch: null,
      liveTestSourceId: "instagram-source:test",
      liveTestCandidateIds: ["instagram:test"],
    },
  };
  assert.deepEqual(selectNextBatch(state), { kind: "follow", candidateIds: ["instagram:test"] });
});

test("an empty live test candidate set cannot consume older candidates from the selected source", () => {
  const state = {
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    candidates: [
      { id: "instagram:older", handle: "older", status: "pending_follow", sourceIds: ["instagram-source:test"] },
    ],
    run: {
      phase: "idle",
      activeBatch: null,
      liveTestSourceId: "instagram-source:test",
      liveTestCandidateIds: [],
    },
  };
  assert.equal(selectNextBatch(state), null);
});

test("a live review updates only captured test candidates", () => {
  const state = {
    ...withFollowedCandidate("older"),
    candidates: [
      withFollowedCandidate("older").candidates[0],
      { ...withFollowedCandidate("fresh").candidates[0], id: "instagram:fresh", normalizedHandle: "fresh" },
    ],
    run: { phase: "idle", activeBatch: null, liveTestSourceId: "instagram-source:test", liveTestCandidateIds: ["instagram:fresh"] },
  };
  const updated = followupModel.applyFollowBackReview(state, ["fresh"], NOW);
  assert.equal(updated.candidates[0].followBackStatus, undefined);
  assert.equal(updated.candidates[1].followBackStatus, "confirmed");
});

test("will not select a new batch while one is active", () => {
  const state = {
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    run: { phase: "running", activeBatch: { kind: "follow", candidateIds: ["a"] } },
    candidates: [{ id: "a", handle: "alice", status: "pending_follow" }],
  };

  assert.equal(selectNextBatch(state, NOW), null);
});

test("retries failed candidates in the queue matching their next action", () => {
  const state = {
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    run: { phase: "idle", activeBatch: null },
    candidates: [
      { id: "follow-retry", handle: "alice", status: "failed", nextAction: "follow" },
      { id: "unfollow-retry", handle: "bob", status: "failed", nextAction: "unfollow" },
    ],
  };

  assert.deepEqual(selectNextBatch(state, NOW), { kind: "unfollow", candidateIds: ["unfollow-retry"] });
  assert.deepEqual(selectNextBatch({ ...state, candidates: [state.candidates[0]] }, NOW), { kind: "follow", candidateIds: ["follow-retry"] });
});

test("rejects noncanonical ISO dates before due comparisons can miss them", () => {
  const state = {
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    run: { phase: "idle", activeBatch: null },
    candidates: [{ id: "a", handle: "alice", status: "pending_unfollow", unfollowDueAt: "2026-08-13T00:00:00Z" }],
  };

  assert.throws(() => getDueUnfollowCandidates(state, NOW), /ISO/i);
});

test("applies only a validated successful action and schedules the unfollow", () => {
  const state = {
    version: 1,
    automationEnabled: true,
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS, unfollowDelayDays: 2 },
    sources: [],
    candidates: [{ id: "a", handle: "alice", sourceIds: ["source-a"], status: "following" }],
    run: { phase: "running", activeBatch: { kind: "follow", candidateIds: ["a"] } },
    history: [],
  };

  const updated = applyActionOutcome(state, { kind: "follow", candidateId: "a" }, { validated: true, success: true }, NOW);

  assert.equal(updated.candidates[0].status, "followed");
  assert.equal(updated.candidates[0].unfollowDueAt, "2026-08-15T01:00:00.000Z");
  assert.deepEqual(updated.history[0], {
    candidateId: "a",
    action: "follow",
    kind: "follow",
    handle: "alice",
    sourceIds: ["source-a"],
    status: "succeeded",
    reason: null,
    timestamp: "2026-08-13T01:00:00.000Z",
    at: "2026-08-13T01:00:00.000Z",
  });
});

test("records unvalidated action outcomes as failures that remain retryable", () => {
  const state = {
    version: 1,
    automationEnabled: true,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [],
    candidates: [{ id: "a", handle: "alice", status: "following" }],
    run: { phase: "running", activeBatch: null },
    history: [],
  };

  const updated = applyActionOutcome(state, { kind: "follow", candidateId: "a" }, { success: true }, NOW);

  assert.equal(updated.candidates[0].status, "failed");
  assert.equal(updated.candidates[0].nextAction, "follow");
  assert.equal(updated.history[0].status, "failed");
});

test("schedules an unknown followed candidate for review on its unfollow deadline", () => {
  assert.equal(typeof followupModel.scheduleFollowBackReview, "function");
  const updated = followupModel.scheduleFollowBackReview(
    withFollowedCandidate("alice"),
    new Date("2026-08-14T01:00:00.000Z"),
  );

  assert.equal(updated.candidates[0].followBackStatus, "unknown");
  assert.equal(updated.candidates[0].followBackReviewDueAt, "2026-08-16T01:00:00.000Z");
});

test("confirmed follow-backs become eligible in the completed review cycle", () => {
  assert.equal(typeof followupModel.applyFollowBackReview, "function");
  const updated = followupModel.applyFollowBackReview(
    withFollowedCandidate("alice", { unfollowDueAt: "2026-08-16T01:00:00.000Z" }),
    ["alice"],
    new Date("2026-08-14T01:00:00.000Z"),
  );

  assert.equal(updated.candidates[0].followBackStatus, "confirmed");
  assert.equal(updated.candidates[0].followBackAt, "2026-08-14T01:00:00.000Z");
  assert.equal(updated.candidates[0].unfollowDueAt, "2026-08-14T01:00:00.000Z");
});

test("unmatched follow-back reviews retain the original unfollow deadline", () => {
  const updated = followupModel.applyFollowBackReview(
    withFollowedCandidate("alice"),
    ["bob"],
    new Date("2026-08-14T01:00:00.000Z"),
  );

  assert.equal(updated.candidates[0].followBackStatus, "unknown");
  assert.equal(updated.candidates[0].lastFollowBackCheckAt, "2026-08-14T01:00:00.000Z");
  assert.equal(updated.candidates[0].unfollowDueAt, "2026-08-16T01:00:00.000Z");
});

test("reports a due follow-back review before the later unfollow deadline", () => {
  assert.equal(typeof followupModel.nextDueLifecycleAt, "function");
  const state = withFollowedCandidate("alice", {
    followBackStatus: "unknown",
    followBackReviewDueAt: "2026-08-14T01:00:00.000Z",
  });

  assert.equal(
    followupModel.nextDueLifecycleAt(state, new Date("2026-08-13T01:00:00.000Z")),
    "2026-08-14T01:00:00.000Z",
  );
});

test("rejects noncanonical follow-back lifecycle dates", () => {
  const state = withFollowedCandidate("alice", { followBackAt: "2026-08-14T01:00:00Z" });

  assert.throws(
    () => followupModel.nextDueLifecycleAt(state, NOW),
    /ISO/i,
  );
});

test("validates and exports the durable follow-back unfollow delay setting", () => {
  assert.equal(DEFAULT_FOLLOWUP_SETTINGS.followBackUnfollowDelayDays, 7);
  const exported = buildLocalExport({
    ...withFollowedCandidate("alice"),
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS, followBackUnfollowDelayDays: 9 },
  });

  assert.equal(exported.settings.followBackUnfollowDelayDays, 9);
});

test("defaults the automatic source rescan interval to six hours", () => {
  assert.equal(DEFAULT_FOLLOWUP_SETTINGS.sourceRescanHours, 6);
});

test("rejects a non-positive source rescan interval", () => {
  assert.throws(
    () => followupModel.validateFollowupSettings({ ...DEFAULT_FOLLOWUP_SETTINGS, sourceRescanHours: 0 }),
    /positive sourceRescanHours/,
  );
});

test("exports only the local follow-up schema", () => {
  const exported = buildLocalExport({
    version: 1,
    automationEnabled: false,
    settings: DEFAULT_FOLLOWUP_SETTINGS,
    sources: [{ id: "source-a", profileUrl: "https://www.instagram.com/alice/", accessToken: "secret", cookie: "secret", custom: "secret" }],
    candidates: [{ id: "a", handle: "alice", status: "pending_follow", password: "secret", sessionid: "secret", privateKey: "secret", custom: "secret" }],
    run: { phase: "idle", activeBatch: null, secret: "secret" },
    history: [{ candidateId: "a", kind: "follow", status: "failed", token: "secret", cookie: "secret", custom: "secret" }],
    credential: "secret",
  });

  assert.deepEqual(Object.keys(exported).sort(), ["candidates", "history", "settings", "sources", "version"]);
  assert.equal(JSON.stringify(exported).includes("secret"), false);
  assert.deepEqual(exported.sources, [{ id: "source-a", profileUrl: "https://www.instagram.com/alice/" }]);
  assert.deepEqual(exported.candidates, [{ id: "a", handle: "alice", status: "pending_follow" }]);
  assert.deepEqual(exported.history, [{ candidateId: "a", kind: "follow", status: "failed" }]);
});

test("exports follow-back lifecycle fields without arbitrary candidate data", () => {
  const exported = buildLocalExport(withFollowedCandidate("alice", {
    followBackStatus: "confirmed",
    lastFollowBackCheckAt: "2026-08-14T01:00:00.000Z",
    followBackAt: "2026-08-14T01:00:00.000Z",
    followBackReviewDueAt: "2026-08-14T01:00:00.000Z",
    privateRelationshipToken: "secret",
  }));

  assert.deepEqual(exported.candidates[0], {
    id: "instagram:alice",
    handle: "alice",
    normalizedHandle: "alice",
    sourceIds: ["source-a"],
    status: "followed",
    createdAt: "2026-08-12T01:00:00.000Z",
    updatedAt: "2026-08-12T01:00:00.000Z",
    followedAt: "2026-08-12T01:00:00.000Z",
    followBackStatus: "confirmed",
    lastFollowBackCheckAt: "2026-08-14T01:00:00.000Z",
    followBackAt: "2026-08-14T01:00:00.000Z",
    followBackReviewDueAt: "2026-08-14T01:00:00.000Z",
    unfollowDueAt: "2026-08-16T01:00:00.000Z",
  });
});

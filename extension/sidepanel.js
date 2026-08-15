const POLL_INTERVAL_MS = 2_000;
// Keep the timeline data available for a future reintroduction without showing it in Autopilot today.
const SHOW_OPERATIONAL_TIMELINE = false;
const ACTIVE_PHASES = new Set(["collecting", "reviewing", "running_batch"]);
const RECOVERY_PHASE = "recovery_required";
const SECTION_IDS = Object.freeze(["autopilot", "sources", "growth", "settings"]);
const SETTING_FIELDS = Object.freeze({
  perSourceLimit: "per-source-limit-input",
  backlogMaximum: "backlog-maximum-input",
  refillThreshold: "refill-threshold-input",
  sourceRescanHours: "source-rescan-hours-input",
  cycleIntervalHours: "cycle-interval-hours-input",
  activeFollowCap: "active-follow-cap-input",
  batchSize: "batch-size-input",
  actionDelayMinSeconds: "action-delay-min-seconds-input",
  actionDelayMaxSeconds: "action-delay-max-seconds-input",
  batchDelayMinMinutes: "batch-delay-min-minutes-input",
  batchDelayMaxMinutes: "batch-delay-max-minutes-input",
  unfollowDelayDays: "unfollow-delay-days-input",
  followBackUnfollowDelayDays: "follow-back-unfollow-delay-days-input",
});
const INTEGER_SETTINGS = new Set([
  "perSourceLimit",
  "backlogMaximum",
  "refillThreshold",
  "batchSize",
  "activeFollowCap",
]);
const PHASE_LABELS = Object.freeze({
  idle: "Ready",
  collecting: "Scanning sources",
  reviewing: "Reviewing follow-backs",
  running_batch: "Working",
  waiting: "Scheduled",
  paused: "Paused",
  blocked: "Needs attention",
  stopped: "Stopped",
  recovery_required: "Resuming automatically",
});
const RECOVERY_MESSAGE = "An interrupted action was skipped automatically and recorded in the local activity log. Autopilot is resuming.";

const $ = (id) => document.getElementById(id);
let followupState = null;
let pollTimer = null;
let refreshPromise = null;
let settingsInitialized = false;
let stateRevision = 0;
let activity = null;
let countdownTimer = null;
let schedulerHealth = null;

function showNotice(message, isError = false) {
  const notice = $("panel-status");
  notice.textContent = message || "";
  notice.hidden = !message;
  notice.classList.toggle("error", isError);
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "The local follow-up engine did not respond.");
  return response;
}

async function refreshConnectionStatus() {
  try {
    const response = await sendMessage({ type: "GET_LOCAL_FOLLOWUP_CONNECTION" });
    const status = $("service-connection-status");
    if (response.connected) {
      status.textContent = `Connected to local Supabase (${response.baseUrl}).`;
      $("service-url-input").value = response.baseUrl;
      $("service-connect-button").textContent = "Reconnect local Supabase";
    }
  } catch {
    // The main state view stays usable if the service is not configured yet.
  }
}

function renderPersistedState(response) {
  if (!response?.state || typeof response.state !== "object") {
    throw new Error("The local follow-up engine returned no persisted state.");
  }
  stateRevision += 1;
  schedulerHealth = response.scheduler || null;
  render(response.state);
}

function selectSection(section) {
  for (const candidate of SECTION_IDS) {
    const selected = candidate === section;
    $(`nav-${candidate}`).setAttribute("aria-selected", String(selected));
    $(`nav-${candidate}`).setAttribute("tabindex", selected ? "0" : "-1");
    $(`${candidate}-section`).hidden = !selected;
  }
}

function handleSectionKeydown(section, event) {
  const currentIndex = SECTION_IDS.indexOf(section);
  let targetIndex;
  if (event.key === "ArrowRight") targetIndex = (currentIndex + 1) % SECTION_IDS.length;
  else if (event.key === "ArrowLeft") targetIndex = (currentIndex - 1 + SECTION_IDS.length) % SECTION_IDS.length;
  else if (event.key === "Home") targetIndex = 0;
  else if (event.key === "End") targetIndex = SECTION_IDS.length - 1;
  else return;
  event.preventDefault();
  const target = SECTION_IDS[targetIndex];
  selectSection(target);
  $(`nav-${target}`).focus();
}

function sourceLabel(source) {
  const path = String(source.profileUrl || "").split("/").filter(Boolean).at(-1);
  return path ? `@${path}` : "Instagram source";
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString();
}

function historyKey(entry) {
  return [
    entry.at || entry.timestamp || "",
    entry.action || entry.kind || "",
    entry.status || "",
    entry.candidateId || entry.handle || "",
  ].join("\u0000");
}

function confirmedFollowsSince(history, baselineKeys) {
  return (history || []).filter((entry) => (
    !baselineKeys.has(historyKey(entry))
    && (entry.action || entry.kind) === "follow"
    && entry.status === "succeeded"
  )).length;
}

function beginActivity(label, kind, metadata = {}) {
  const baseline = new Set((followupState?.history || []).map(historyKey));
  activity = {
    status: "running",
    label,
    kind,
    baselineKeys: baseline,
    count: 0,
    sawActivePhase: false,
    sawQueueMarker: false,
    ...metadata,
  };
  renderLiveStatus(followupState || { run: { phase: "idle" }, history: [] });
}

function phaseActivityLabel(state) {
  switch (state.run?.phase) {
    case "collecting": return "Scanning sources";
    case "reviewing": return "Reviewing follow-backs";
    case "running_batch": return state.run?.activeBatch?.kind === "unfollow"
      ? "Processing due unfollows"
      : "Following verified accounts";
    default: return "";
  }
}

function renderLiveStatus(state) {
  const indicator = $("live-run-status");
  const message = $("live-run-message");
  const persistedLabel = phaseActivityLabel(state);
  if (activity && persistedLabel) activity.sawActivePhase = true;
  const queuedScanMarker = activity?.kind === "scan"
    && state.run?.sourceScanSourceId === activity.sourceId;
  if (queuedScanMarker) activity.sawQueueMarker = true;
  if (activity?.kind === "scan"
    && (activity.sawActivePhase || activity.sawQueueMarker)
    && !persistedLabel
    && !queuedScanMarker
    && activity.status !== "error") {
    activity.status = "complete";
    activity.label = "Scan finished";
  }

  if (!activity && !persistedLabel) {
    indicator.hidden = true;
    return;
  }

  const status = persistedLabel ? "running" : activity.status;
  const label = persistedLabel || activity.label;
  indicator.hidden = false;
  indicator.classList.toggle("is-running", status === "running");
  indicator.classList.toggle("is-complete", status === "queued" || status === "complete");
  indicator.classList.toggle("is-error", status === "error");
  if (!activity) {
    message.textContent = `${label}…`;
    return;
  }
  const count = confirmedFollowsSince(state.history, activity.baselineKeys);
  activity.count = count;
  message.textContent = status === "error"
    ? `${label} · ${count} followed this run`
    : `${label}${status === "running" ? "…" : ""} · ${count} followed this run`;
}

function isMutationLocked(state) {
  return ACTIVE_PHASES.has(state.run?.phase);
}

function renderSources(state) {
  const list = $("source-list");
  list.innerHTML = "";
  const sources = state.sources || [];
  const locked = isMutationLocked(state);
  $("source-count").textContent = String(sources.length);
  $("sources-empty").hidden = sources.length > 0;

  for (const source of sources) {
    const item = document.createElement("li");
    const details = document.createElement("div");
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    const actions = document.createElement("div");
    const scan = document.createElement("button");
    const liveTest = document.createElement("button");
    const remove = document.createElement("button");

    title.textContent = sourceLabel(source);
    meta.textContent = `${source.status || "pending"} · limit ${source.limit || state.settings.perSourceLimit}`;
    if (source.warning) meta.textContent += ` · ${source.warning}`;
    details.append(title, meta);

    actions.className = "source-actions";
    scan.type = "button";
    scan.className = "text-button";
    scan.textContent = "Scan now";
    scan.setAttribute("aria-label", `Scan ${sourceLabel(source)} now`);
    scan.disabled = locked;
    scan.addEventListener("click", () => scanSource(source.id, scan));

    liveTest.type = "button";
    liveTest.className = "text-button";
    liveTest.textContent = "Live test · 10";
    liveTest.setAttribute("aria-label", `Run a ten-profile live test from ${sourceLabel(source)}`);
    liveTest.disabled = locked;
    liveTest.addEventListener("click", async () => {
      try {
        liveTest.disabled = true;
        beginActivity("Starting live 10-profile test", "live-test");
        const response = await sendMessage({ type: "START_LIVE_ACCELERATED_TEST", payload: { sourceId: source.id } });
        renderPersistedState(response);
        activity.status = "active";
        activity.label = "Live test active";
        renderLiveStatus(response.state);
        showNotice("Live test active: calendar checks are accelerated; Instagram action spacing is unchanged.");
      } catch (error) {
        liveTest.disabled = false;
        activity = null;
        showNotice(error.message, true);
      }
    });

    remove.type = "button";
    remove.className = "text-danger";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${sourceLabel(source)}`);
    remove.disabled = locked;
    remove.addEventListener("click", async () => {
      try {
        remove.disabled = true;
        const response = await sendMessage({ type: "REMOVE_SOURCE", payload: { sourceId: source.id } });
        renderPersistedState(response);
        showNotice("Source removed. Existing candidates and history were kept.");
      } catch (error) {
        remove.disabled = false;
        showNotice(error.message, true);
      }
    });

    actions.append(scan, liveTest, remove);
    item.append(details, actions);
    list.appendChild(item);
  }
}

function dueUnfollowCandidates(state, now = new Date()) {
  const iso = now.toISOString();
  return (state.candidates || []).filter((candidate) => (
    candidate.status === "failed" && candidate.nextAction === "unfollow"
  ) || (
    candidate.status === "pending_unfollow"
    && candidate.unfollowDueAt
    && candidate.unfollowDueAt <= iso
  ));
}

function dueUnfollowCount(state, now = new Date()) {
  return dueUnfollowCandidates(state, now).length;
}

function successfulFollowHistory(state) {
  return (state.history || []).filter((entry) => (
    (entry.action || entry.kind) === "follow" && entry.status === "succeeded"
  ));
}

function weeklyFollowCount(state, now = new Date()) {
  const cutoff = now.getTime() - (7 * 24 * 60 * 60 * 1_000);
  return successfulFollowHistory(state).filter((entry) => {
    const timestamp = new Date(entry.at || entry.timestamp).getTime();
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
  }).length;
}

function growthMetrics(state) {
  const candidates = state.candidates || [];
  const confirmed = candidates.filter(({ followBackStatus }) => followBackStatus === "confirmed").length;
  const waiting = candidates.filter(({ status, followBackStatus }) => (
    status === "followed" && followBackStatus !== "confirmed"
  )).length;
  const trackedIds = new Set(candidates.map(({ id }) => id).filter(Boolean));
  const trackedHandles = new Set(candidates.map(({ normalizedHandle, handle }) => (
    String(normalizedHandle || handle || "").toLowerCase()
  )).filter(Boolean));
  const followedIdentities = new Set(successfulFollowHistory(state).flatMap((entry) => {
    if (entry.candidateId && trackedIds.has(entry.candidateId)) return [entry.candidateId];
    const handle = String(entry.handle || "").toLowerCase();
    return handle && trackedHandles.has(handle) ? [handle] : [];
  }));
  const conversion = followedIdentities.size
    ? Math.min(100, Math.round((confirmed / followedIdentities.size) * 100))
    : 0;
  return {
    weeklyFollows: weeklyFollowCount(state),
    confirmed,
    conversion,
    waiting,
    due: dueUnfollowCount(state),
  };
}

function renderMetrics(state) {
  const metrics = growthMetrics(state);
  $("weekly-follow-count").textContent = String(metrics.weeklyFollows);
  $("autopilot-confirmed-count").textContent = String(metrics.confirmed);
  $("autopilot-conversion-rate").textContent = `${metrics.conversion}%`;
  $("confirmed-followback-count").textContent = String(metrics.confirmed);
  $("conversion-rate").textContent = `${metrics.conversion}%`;
  $("waiting-count").textContent = String(metrics.waiting);
  $("due-unfollow-count").textContent = String(metrics.due);

  const pending = (state.candidates || []).filter(({ status, nextAction }) => (
    status === "pending_follow" || (status === "failed" && nextAction === "follow")
  )).length;
  const maximum = Number(state.settings?.backlogMaximum) || 1;
  $("backlog-count").textContent = `${pending} / ${maximum}`;
  $("backlog-progress").style.width = `${Math.min(100, (pending / maximum) * 100)}%`;
}

function renderHistory(state) {
  const list = $("history-list");
  list.innerHTML = "";
  const history = [...(state.history || [])].reverse().slice(0, 10);
  $("history-empty").hidden = history.length > 0;
  for (const entry of history) {
    const item = document.createElement("li");
    const action = entry.action || entry.kind || "action";
    const reason = entry.reason ? ` · ${entry.reason}` : "";
    const handle = entry.handle || String(entry.candidateId || "").split(":").at(-1) || "unknown";
    item.textContent = `@${handle} · ${action} · ${entry.status || "unknown"}${reason} · ${formatDate(entry.at || entry.timestamp)}`;
    list.appendChild(item);
  }
}

function renderSettings(state) {
  if (settingsInitialized) return;
  for (const [setting, id] of Object.entries(SETTING_FIELDS)) {
    $(id).value = String(state.settings[setting]);
  }
  $("source-limit-input").value = String(state.settings.perSourceLimit);
  settingsInitialized = true;
}

function candidateById(state, candidateId) {
  return (state.candidates || []).find(({ id }) => id === candidateId) || null;
}

function sourceForCandidate(state, candidate) {
  if (!candidate?.sourceIds?.length) return null;
  return (state.sources || []).find((source) => candidate.sourceIds.some((sourceId) => (
    String(source.id || "").toLowerCase() === String(sourceId || "").toLowerCase()
  ))) || null;
}

function actionLabel(kind) {
  return kind === "unfollow" ? "Unfollow" : "Follow";
}

function validDeadline(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function countdownLabel(deadline, now) {
  const milliseconds = deadline.getTime() - now.getTime();
  if (milliseconds <= 0) return "Ready now";
  const totalSeconds = Math.ceil(milliseconds / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  const clock = [hours, minutes, seconds]
    .map((value, index) => (index === 0 && totalHours === 0 ? null : String(value).padStart(2, "0")))
    .filter((value) => value !== null)
    .join(":");
  return `in ${days ? `${days}d ` : ""}${clock}`;
}

function actionPreview(state, batch, candidates) {
  return candidates.slice(1, 4).map((candidate, index) => ({
    title: `${actionLabel(batch.kind)} @${candidate.handle}`,
    detail: `after ${index + 1} action${index === 0 ? "" : "s"}`,
  }));
}

function queuedActionPreview(state, kind, candidates) {
  return candidates.slice(0, 3).map((candidate) => {
    const source = sourceForCandidate(state, candidate);
    return {
      title: `${actionLabel(kind)} @${candidate.handle}`,
      detail: source ? `from ${sourceLabel(source)}` : "ready in queue",
    };
  });
}

function nextWorkModel(state, now = new Date()) {
  const phase = state.run?.phase;
  if (phase === RECOVERY_PHASE) return { state: "static", title: "Resuming autopilot", detail: "The interrupted action was skipped automatically and recorded in the activity log.", preview: [] };
  if (phase === "reviewing") return { state: "active", title: "Follow-back review in progress", detail: "Checking your own followers; no action timer is estimated.", preview: [] };
  if (phase === "collecting") {
    const source = (state.sources || []).find(({ id }) => String(id).toLowerCase() === String(state.run?.sourceScanSourceId || "").toLowerCase());
    return { state: "active", title: source ? `Scanning ${sourceLabel(source)}` : "Source scan in progress", detail: "Instagram collection is in progress; no action timer is estimated.", preview: [] };
  }

  const batch = state.run?.activeBatch;
  if (batch?.candidateIds?.length) {
    const candidates = batch.candidateIds.map((candidateId) => candidateById(state, candidateId)).filter(Boolean);
    const candidate = candidates[0];
    if (candidate) {
      const source = sourceForCandidate(state, candidate);
      const deadline = validDeadline(state.run?.nextWorkAt);
      return {
        state: deadline ? "scheduled" : "ready",
        title: `${actionLabel(batch.kind)} @${candidate.handle}`,
        detail: source ? `From ${sourceLabel(source)} · ${candidates.length - 1} account${candidates.length === 2 ? "" : "s"} after this` : `${candidates.length - 1} account${candidates.length === 2 ? "" : "s"} after this`,
        deadline,
        preview: actionPreview(state, batch, candidates),
      };
    }
  }

  const cycleDeadline = validDeadline(state.run?.cycle?.dueAt);
  const pendingCandidates = (state.candidates || []).filter(({ status, nextAction }) => (
    status === "pending_follow" || (status === "failed" && nextAction === "follow")
  ));
  if (cycleDeadline && cycleDeadline > now && state.run?.cycle?.stage === "review") {
    const pending = pendingCandidates.length;
    return {
      state: "scheduled",
      title: pending ? `${pending} follow${pending === 1 ? "" : "s"} queued for the global cycle` : "Global cycle",
      detail: "Review follow-backs, collect a source, then up to 50 unfollows and 50 follows.",
      deadline: cycleDeadline,
      preview: pending ? queuedActionPreview(state, "follow", pendingCandidates) : [],
    };
  }

  const dueCandidates = dueUnfollowCandidates(state, now);
  if (dueCandidates.length) return {
    state: "ready",
    title: `Unfollow @${dueCandidates[0].handle} · ${dueCandidates.length} ready`,
    detail: "Starting in the global action lane now.",
    preview: queuedActionPreview(state, "unfollow", dueCandidates),
  };

  const pending = pendingCandidates.length;
  const nowIso = now.toISOString();
  if (state.run?.nextRelationshipReviewAt && state.run.nextRelationshipReviewAt <= nowIso) {
    return { state: "ready", title: "Follow-back review · ready now", detail: "Starting in the global action lane now.", preview: [] };
  }
  if (pending) return {
    state: "ready",
    title: `Follow @${pendingCandidates[0].handle} · ${pending} waiting`,
    detail: "Starting in the global action lane now.",
    preview: queuedActionPreview(state, "follow", pendingCandidates),
  };
  if (state.run?.nextSourceScanAt && state.run.nextSourceScanAt <= nowIso) {
    const source = (state.sources || []).find(({ id }) => String(id).toLowerCase() === String(state.run?.sourceScanSourceId || "").toLowerCase());
    return { state: "ready", title: source ? `Scan ${sourceLabel(source)} · ready now` : "Source scan · ready now", detail: "Starting in the global action lane now.", preview: [] };
  }

  const scheduled = [
    state.run?.cycle?.dueAt
      ? { title: "Global cycle", detail: "Review follow-backs, collect a source, then up to 50 unfollows and 50 follows.", at: state.run.cycle.dueAt }
      : null,
    state.run?.nextRelationshipReviewAt
      ? { title: "Follow-back review", detail: "Checking which followed accounts now follow you back.", at: state.run.nextRelationshipReviewAt }
      : null,
    state.run?.nextSourceScanAt
      ? (() => {
        const source = (state.sources || []).find(({ id }) => String(id).toLowerCase() === String(state.run?.sourceScanSourceId || "").toLowerCase());
        return { title: source ? `Scan ${sourceLabel(source)}` : "Source scan", detail: "Collecting the next visible followers from this source.", at: state.run.nextSourceScanAt };
      })()
      : null,
  ].filter(Boolean).map((entry) => ({ ...entry, deadline: validDeadline(entry.at) })).filter(({ deadline }) => deadline).sort((first, second) => first.deadline - second.deadline);
  if (scheduled.length) return { state: "scheduled", ...scheduled[0], preview: [] };
  if (!(state.sources || []).length) return { state: "static", title: "Add a source to begin", detail: "No Instagram source is in the local queue.", preview: [] };
  return { state: "static", title: state.automationEnabled ? "Watching for the next due action" : "Start Autopilot when ready", detail: "No action is currently scheduled.", preview: [] };
}

function stopCountdown() {
  if (countdownTimer === null) return;
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function renderCountdownTick() {
  if (followupState) renderNextWork(followupState, new Date());
}

function startCountdown() {
  if (document.visibilityState === "hidden" || countdownTimer !== null) return;
  countdownTimer = setInterval(renderCountdownTick, 1_000);
}

function renderNextWork(state, now = new Date()) {
  const model = nextWorkModel(state, now);
  const cycleDeadline = validDeadline(state.run?.cycle?.dueAt);
  const statePill = $("next-work-state");
  const countdown = $("next-work-countdown");
  const detail = $("next-work-detail");
  const scheduledAt = $("next-work-scheduled-at");
  const alarmStatus = $("next-work-alarm-status");
  const runNextCycleButton = $("run-next-cycle-button");
  const previewWrap = $("next-work-preview-wrap");
  const preview = $("next-work-preview");
  $("next-work").textContent = model.title;
  detail.textContent = model.detail || "";
  statePill.textContent = model.state === "active" ? "Live" : model.state === "scheduled" ? "Scheduled" : model.state === "ready" ? "Ready" : "Waiting";
  statePill.classList.toggle("active", model.state === "active" || model.state === "scheduled");
  preview.innerHTML = "";
  for (const item of model.preview || []) {
    const row = document.createElement("li");
    const title = document.createElement("span");
    const timing = document.createElement("span");
    title.textContent = item.title;
    timing.textContent = item.detail;
    row.append(title, timing);
    preview.appendChild(row);
  }
  previewWrap.hidden = !(model.preview || []).length;
  const canRunNextCycleNow = Boolean(
    state.automationEnabled
    && cycleDeadline
    && cycleDeadline > now
    && state.run?.cycle?.stage === "review"
    && !state.run?.activeBatch
    && !["collecting", "reviewing", RECOVERY_PHASE, "paused", "stopped"].includes(state.run?.phase),
  );
  runNextCycleButton.hidden = !canRunNextCycleNow;
  runNextCycleButton.disabled = !canRunNextCycleNow || isMutationLocked(state);
  if (model.deadline) {
    countdown.hidden = false;
    countdown.textContent = countdownLabel(model.deadline, now);
    scheduledAt.hidden = false;
    scheduledAt.textContent = `Scheduled ${formatDate(model.deadline.toISOString())}`;
    const matchesDeadline = schedulerHealth?.plannedAt === model.deadline.toISOString();
    const status = matchesDeadline ? schedulerHealth.status : null;
    alarmStatus.hidden = !status;
    alarmStatus.textContent = status === "armed"
      ? "Chrome alarm armed for this cycle."
      : status === "rearmed"
        ? "Chrome alarm was re-armed for this cycle."
        : status === "unverified"
          ? "Chrome alarm could not be verified."
          : "";
    startCountdown();
  } else {
    countdown.hidden = true;
    countdown.textContent = "";
    scheduledAt.hidden = true;
    scheduledAt.textContent = "";
    alarmStatus.hidden = true;
    alarmStatus.textContent = "";
    stopCountdown();
  }
}

function renderOperationalTimeline(state, now = new Date()) {
  const timeline = $("operational-timeline");
  timeline.innerHTML = "";
  const cycle = state.run?.cycle;
  const cycleDeadline = validDeadline(cycle?.dueAt);
  const entries = [];
  if (cycleDeadline) {
    entries.push({ label: "Programmé", title: "Cycle global · revue, collecte, unfollows, follows", detail: formatDate(cycleDeadline.toISOString()), at: cycleDeadline });
    const interval = Number(state.settings?.cycleIntervalHours) || 4;
    const horizon = now.getTime() + (48 * 3_600_000);
    for (let at = new Date(cycleDeadline.getTime() + (interval * 3_600_000)); at.getTime() <= horizon; at = new Date(at.getTime() + (interval * 3_600_000))) {
      const eligible = (state.candidates || []).filter((candidate) => candidate.status === "followed" && candidate.followedAt && Date.parse(candidate.followedAt) + (48 * 3_600_000) <= at.getTime()).length;
      entries.push({ label: "Prévision", title: `Cycle global · jusqu’à 50 unfollows puis 50 follows`, detail: `${formatDate(at.toISOString())} · ${eligible} atteignent 48 h`, at });
    }
  }
  if (!entries.length) entries.push({ label: "Programmé", title: "Aucun cycle programmé", detail: state.automationEnabled ? "En attente d’une échéance persistée." : "Autopilot arrêté." });
  for (const entry of entries) {
    const row = document.createElement("li");
    const title = document.createElement("span");
    const detail = document.createElement("span");
    title.textContent = `${entry.label} · ${entry.title}`;
    detail.textContent = entry.detail;
    row.append(title, detail);
    timeline.append(row);
  }
}

function renderLifecycle(state) {
  const phase = state.run?.phase || "idle";
  const enabled = state.automationEnabled === true;
  const active = ACTIVE_PHASES.has(phase);
  const recovery = false;
  const phaseLabel = PHASE_LABELS[phase] || phase;
  const controls = {
    start: $("start-auto-button"),
    pause: $("pause-button"),
    resume: $("resume-button"),
    stop: $("stop-button"),
  };

  $("phase-pill").textContent = phaseLabel;
  $("phase-pill").classList.toggle("active", enabled && !recovery);
  $("phase-pill").classList.toggle("recovery", recovery);
  $("automation-status").textContent = `Autopilot ${enabled ? "on" : "off"} · ${phaseLabel}`;
  $("recovery-notice").textContent = RECOVERY_MESSAGE;
  $("recovery-notice").hidden = !recovery;

  controls.start.hidden = true;
  controls.pause.hidden = true;
  controls.resume.hidden = true;
  controls.stop.hidden = true;
  if (phase === "paused") controls.resume.hidden = false;
  else if (enabled || active || phase === RECOVERY_PHASE) controls.pause.hidden = false;
  else controls.start.hidden = false;
  controls.stop.hidden = !(enabled || active || phase === "paused" || phase === RECOVERY_PHASE);
  for (const button of Object.values(controls)) button.disabled = false;

  const locked = isMutationLocked(state);
  $("add-source-button").disabled = locked;
  $("settings-save-button").disabled = locked;
  $("export-button").disabled = false;
  $("reset-button").disabled = locked;
  $("follow-back-review-button").disabled = locked;
  renderNextWork(state);
  $("operational-timeline-card").hidden = !SHOW_OPERATIONAL_TIMELINE;
  renderOperationalTimeline(state);
}

function render(state) {
  followupState = state;
  renderLifecycle(state);
  renderLiveStatus(state);
  renderSources(state);
  renderMetrics(state);
  renderHistory(state);
  renderSettings(state);
}

async function refreshState() {
  if (refreshPromise) return refreshPromise;
  const requestedRevision = stateRevision;
  refreshPromise = (async () => {
    try {
      const response = await sendMessage({ type: "GET_FOLLOWUP_STATE" });
      if (requestedRevision === stateRevision) {
        schedulerHealth = response.scheduler || null;
        render(response.state);
      }
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function addSource() {
  const input = $("source-input").value.trim();
  const limit = Number.parseInt($("source-limit-input").value, 10);
  if (!input) {
    showNotice("Enter an Instagram profile URL or handle.", true);
    return;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    showNotice("Source limit must be a positive integer.", true);
    return;
  }

  const button = $("add-source-button");
  try {
    button.disabled = true;
    const response = await sendMessage({ type: "ADD_SOURCE", payload: { input, limit } });
    renderPersistedState(response);
    showNotice("Source added locally.");
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = isMutationLocked(followupState || { run: {} });
  }
}

async function scanSource(sourceId, button) {
  beginActivity("Scanning source", "scan", { sourceId });
  try {
    button.disabled = true;
    const response = await sendMessage({ type: "SCAN_NOW", payload: { sourceId } });
    renderPersistedState(response);
    activity.status = "queued";
    activity.label = "Scan queued";
    renderLiveStatus(response.state);
    showNotice("Source scan queued in the local action lane.");
  } catch (error) {
    activity.status = "error";
    activity.label = error.message;
    renderLiveStatus(followupState || { run: {}, history: [] });
    showNotice(error.message, true);
  } finally {
    button.disabled = isMutationLocked(followupState || { run: {} });
  }
}

async function runFollowBackReview() {
  const button = $("follow-back-review-button");
  beginActivity("Checking follow-backs", "follow-back-review");
  try {
    button.disabled = true;
    button.classList.toggle("is-running", true);
    const response = await sendMessage({ type: "RUN_FOLLOW_BACK_REVIEW" });
    renderPersistedState(response);
    activity.status = "complete";
    activity.label = "Follow-back check complete";
    renderLiveStatus(response.state);
  } catch (error) {
    activity.status = "error";
    activity.label = error.message;
    renderLiveStatus(followupState || { run: {}, history: [] });
    showNotice(error.message, true);
  } finally {
    button.classList.toggle("is-running", false);
    button.disabled = isMutationLocked(followupState || { run: {} });
  }
}

async function runNextCycleNow() {
  const button = $("run-next-cycle-button");
  beginActivity("Starting scheduled cycle", "cycle");
  try {
    button.disabled = true;
    const response = await sendMessage({ type: "RUN_NEXT_CYCLE_NOW" });
    renderPersistedState(response);
    activity.status = "queued";
    activity.label = "Scheduled cycle advanced";
    renderLiveStatus(response.state);
    showNotice("The global cycle was moved to now.");
  } catch (error) {
    activity.status = "error";
    activity.label = error.message;
    renderLiveStatus(followupState || { run: {}, history: [] });
    showNotice(error.message, true);
  } finally {
    button.disabled = !followupState || isMutationLocked(followupState);
  }
}

async function applyControl(type) {
  if (type === "START_AUTO" || type === "RESUME_AUTO") {
    beginActivity(type === "START_AUTO" ? "Starting Autopilot" : "Resuming Autopilot", "autopilot");
  }
  try {
    const response = await sendMessage({ type });
    renderPersistedState(response);
    if ((type === "START_AUTO" || type === "RESUME_AUTO") && activity) {
      activity.status = "active";
      activity.label = "Autopilot active";
      renderLiveStatus(response.state);
    }
    if (type === "PAUSE_AUTO" || type === "STOP_AUTO") {
      activity = null;
      renderLiveStatus(response.state);
    }
    showNotice("Autopilot state updated.");
  } catch (error) {
    if (type === "START_AUTO" || type === "RESUME_AUTO") activity = null;
    renderLiveStatus(followupState || { run: {}, history: [] });
    showNotice(error.message, true);
  }
}

function readSettings() {
  return Object.fromEntries(Object.entries(SETTING_FIELDS).map(([setting, id]) => [
    setting,
    Number($(id).value),
  ]));
}

function validateSettings(settings) {
  for (const [setting, value] of Object.entries(settings)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("Every cadence and retention value must be greater than zero.");
    }
    if (INTEGER_SETTINGS.has(setting) && !Number.isInteger(value)) {
      throw new Error("Source, backlog, refill, and cycle counts must be whole numbers.");
    }
  }
  if (settings.refillThreshold >= settings.backlogMaximum) {
    throw new Error("Refill threshold must stay below the backlog maximum.");
  }
  if (settings.batchSize > settings.backlogMaximum) {
    throw new Error("Accounts per cycle must not exceed the backlog maximum.");
  }
  if (settings.perSourceLimit > settings.backlogMaximum) {
    throw new Error("Default source limit must not exceed the backlog maximum.");
  }
  if (settings.actionDelayMinSeconds > settings.actionDelayMaxSeconds) {
    throw new Error("Action delay minimum cannot exceed its maximum.");
  }
  if (settings.batchDelayMinMinutes > settings.batchDelayMaxMinutes) {
    throw new Error("Cycle pause minimum cannot exceed its maximum.");
  }
}

async function saveSettings() {
  const settings = readSettings();
  try {
    validateSettings(settings);
    const response = await sendMessage({ type: "SAVE_FOLLOWUP_SETTINGS", payload: { settings } });
    renderPersistedState(response);
    $("source-limit-input").value = String(settings.perSourceLimit);
    showNotice("Settings saved locally.");
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function connectLocalService() {
  const baseUrl = $("service-url-input").value.trim();
  const handle = $("service-handle-input").value.trim();
  const pairingToken = $("service-token-input").value.trim();
  try {
    if (!baseUrl || !handle || !pairingToken) throw new Error("Enter the local service URL, your Instagram handle, and the pairing token.");
    const response = await sendMessage({ type: "PAIR_LOCAL_FOLLOWUP_SERVICE", payload: { baseUrl, handle, pairingToken } });
    $("service-token-input").value = "";
    renderPersistedState(response);
    await refreshConnectionStatus();
    showNotice(`Connected local Supabase for @${response.account.normalizedHandle}.`);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function exportState() {
  try {
    const response = await sendMessage({ type: "EXPORT_FOLLOWUP_STATE" });
    const blob = new Blob([response.json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `instagram-followup-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showNotice("Local export downloaded.");
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function resetState() {
  if (!window.confirm("Reset all local sources, candidates, history, and settings?")) return;
  try {
    const response = await sendMessage({ type: "RESET_FOLLOWUP_STATE" });
    settingsInitialized = false;
    activity = null;
    renderPersistedState(response);
    showNotice("Local follow-up data reset.");
  } catch (error) {
    showNotice(error.message, true);
  }
}

function startPolling() {
  if (document.visibilityState === "hidden" || pollTimer !== null) return;
  void refreshState();
  pollTimer = setInterval(refreshState, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

for (const section of SECTION_IDS) {
  $(`nav-${section}`).addEventListener("click", () => selectSection(section));
  $(`nav-${section}`).addEventListener("keydown", (event) => handleSectionKeydown(section, event));
}
$("add-source-button").addEventListener("click", addSource);
$("start-auto-button").addEventListener("click", () => applyControl("START_AUTO"));
$("pause-button").addEventListener("click", () => applyControl("PAUSE_AUTO"));
$("resume-button").addEventListener("click", () => applyControl("RESUME_AUTO"));
$("stop-button").addEventListener("click", () => applyControl("STOP_AUTO"));
$("follow-back-review-button").addEventListener("click", runFollowBackReview);
$("run-next-cycle-button").addEventListener("click", runNextCycleNow);
$("settings-save-button").addEventListener("click", saveSettings);
$("service-connect-button").addEventListener("click", connectLocalService);
$("export-button").addEventListener("click", exportState);
$("reset-button").addEventListener("click", resetState);

for (const id of [
  "start-auto-button",
  "pause-button",
  "resume-button",
  "stop-button",
  "add-source-button",
  "settings-save-button",
  "export-button",
  "reset-button",
  "follow-back-review-button",
  "run-next-cycle-button",
]) {
  $(id).disabled = true;
}

selectSection("autopilot");
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopPolling();
    stopCountdown();
  } else {
    startPolling();
    renderCountdownTick();
  }
});
window.addEventListener("pagehide", () => {
  stopPolling();
  stopCountdown();
});
startPolling();
void refreshConnectionStatus();

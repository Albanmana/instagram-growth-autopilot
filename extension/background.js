import { createFollowupEngine } from "./followup-engine.js";
import { normalizeSourceInput } from "./followup-model.js";
import { createFollowupStore } from "./followup-store.js";
import { createFollowupHealth } from "./followup-health.js";
import { performInstagramRelationshipAction } from "./instagram-follow-actions.js";
import { createInstagramFollowers } from "./instagram-followers.js";

export const INSTAGRAM_FOLLOWUP_NEXT_WORK = "INSTAGRAM_FOLLOWUP_NEXT_WORK";
export const INSTAGRAM_GROWTH_RETRY = "INSTAGRAM_GROWTH_RETRY";

const TAB_LOAD_TIMEOUT_MS = 30_000;
const LOCAL_MESSAGE_TYPES = new Set([
  "GET_FOLLOWUP_STATE",
  "ADD_SOURCE",
  "REMOVE_SOURCE",
  "RUN_MANUAL_SOURCE",
  "SCAN_NOW",
  "RUN_FOLLOW_BACK_REVIEW",
  "RUN_NEXT_CYCLE_NOW",
  "START_AUTO",
  "PAUSE_AUTO",
  "RESUME_AUTO",
  "STOP_AUTO",
  "SAVE_FOLLOWUP_SETTINGS",
  "EXPORT_FOLLOWUP_STATE",
  "RESET_FOLLOWUP_STATE",
  "GET_FOLLOWUP_HEALTH",
  "RETRY_FOLLOWUP_WORK",
]);

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown error");
}

function schedulerDeadline(state) {
  const deadline = state?.run?.nextWorkAt;
  if (typeof deadline !== "string" || Number.isNaN(Date.parse(deadline))) return null;
  return deadline;
}

async function verifyScheduledAlarm(chromeApi, state) {
  const plannedAt = schedulerDeadline(state);
  if (!plannedAt) return { status: "idle", plannedAt: null, alarmAt: null };
  const alarms = chromeApi.alarms;
  if (typeof alarms?.get !== "function" || typeof alarms?.create !== "function") {
    return { status: "unverified", plannedAt, alarmAt: null };
  }
  const plannedMs = Date.parse(plannedAt);
  const alarm = await alarms.get(INSTAGRAM_FOLLOWUP_NEXT_WORK);
  const alarmAt = Number.isFinite(alarm?.scheduledTime) ? new Date(alarm.scheduledTime).toISOString() : null;
  if (alarmAt && Math.abs(Date.parse(alarmAt) - plannedMs) <= 1_000) {
    return { status: "armed", plannedAt, alarmAt };
  }
  await alarms.create(INSTAGRAM_FOLLOWUP_NEXT_WORK, { when: plannedMs });
  return { status: "rearmed", plannedAt, alarmAt: plannedAt };
}

function instagramSessionIsAvailable(url) {
  if (typeof url !== "string" || !url) return true;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase() === "instagram.com"
      && !parsed.pathname.toLowerCase().startsWith("/accounts/login");
  } catch {
    return false;
  }
}

async function waitForTabLoad(chromeApi, tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chromeApi.tabs.onUpdated.removeListener(onUpdated);
      chromeApi.tabs.onRemoved?.removeListener(onRemoved);
      operation(value);
    };
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish(resolve, tab);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(reject, new Error("Instagram tab was closed before it loaded."));
    };
    const timeoutId = setTimeout(() => {
      finish(reject, new Error("Instagram tab did not finish loading in time."));
    }, TAB_LOAD_TIMEOUT_MS);

    chromeApi.tabs.onUpdated.addListener(onUpdated);
    chromeApi.tabs.onRemoved?.addListener(onRemoved);
    void chromeApi.tabs.get(tabId).then((existing) => {
      if (existing?.status === "complete") finish(resolve, existing);
    }, (error) => finish(reject, error));
  });
}

async function waitForTabUrl(chromeApi, tabId, expectedUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      chromeApi.tabs.onUpdated.removeListener(onUpdated);
      chromeApi.tabs.onRemoved?.removeListener(onRemoved);
      operation(value);
    };
    const normalizedProfileUrl = (url) => {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
        const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
        return `${host}${pathname}`;
      } catch {
        return null;
      }
    };
    const expectedProfile = normalizedProfileUrl(expectedUrl);
    const matches = (url) => expectedProfile != null && normalizedProfileUrl(url) === expectedProfile;
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && matches(changeInfo.url || tab?.url)) finish(resolve, tab);
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) finish(reject, new Error("Instagram tab was closed before its profile loaded."));
    };
    const timeoutId = setTimeout(() => {
      finish(reject, new Error("Instagram profile did not load in time."));
    }, TAB_LOAD_TIMEOUT_MS);

    chromeApi.tabs.onUpdated.addListener(onUpdated);
    chromeApi.tabs.onRemoved?.addListener(onRemoved);
    void chromeApi.tabs.get(tabId).then((existing) => {
      if (matches(existing?.url)) finish(resolve, existing);
    }, (error) => finish(reject, error));
  });
}

export function createChromeTabGateway(chromeApi) {
  return {
    async openTabAndWait(url, active = true, { waitForComplete = true, waitForUrl = false } = {}) {
      let tab = null;
      try {
        tab = await chromeApi.tabs.create({ url, active });
        if (!tab?.id) throw new Error("Chrome did not return a tab id.");
        const loaded = waitForComplete
          ? await waitForTabLoad(chromeApi, tab.id)
          : waitForUrl
            ? await waitForTabUrl(chromeApi, tab.id, url)
            : await chromeApi.tabs.get(tab.id);
        if (!instagramSessionIsAvailable(loaded?.url || tab.url)) {
          throw new Error("Instagram session is unavailable. Log in to Instagram in this browser and try again.");
        }
        return { ...tab, ...loaded, id: tab.id };
      } catch (error) {
        if (tab?.id) await chromeApi.tabs.remove(tab.id).catch(() => undefined);
        throw error;
      }
    },
    executeScript(options) {
      return chromeApi.scripting.executeScript(options);
    },
    closeTab(tabId) {
      return chromeApi.tabs.remove(tabId);
    },
  };
}

export function createInstagramRelationshipGateway({
  openTabAndWait,
  executeScript,
  closeTab,
  ownHandle,
  getOwnHandle,
  waitForProfile = () => new Promise((resolve) => setTimeout(resolve, 1_000)),
} = {}) {
  for (const [name, dependency] of Object.entries({ openTabAndWait, executeScript, closeTab, waitForProfile })) {
    if (typeof dependency !== "function") throw new Error(`${name} must be a function.`);
  }
  if (getOwnHandle !== undefined && typeof getOwnHandle !== "function") {
    throw new Error("getOwnHandle must be a function.");
  }
  return async function performRelationshipAction({ expectedHandle, action, actionContext } = {}) {
    let profileUrl;
    try {
      profileUrl = normalizeSourceInput(expectedHandle);
    } catch {
      return { status: "failed", reason: "The queued Instagram handle is invalid." };
    }
    let tab = null;
    try {
      tab = await openTabAndWait(profileUrl, true, { waitForComplete: true });
      if (!tab?.id) throw new Error("Chrome did not return a tab id.");
      await waitForProfile(tab);

      const [execution] = await executeScript({
        target: { tabId: tab.id },
        injectImmediately: true,
        func: performInstagramRelationshipAction,
        args: [{ expectedHandle, action, actionContext }],
      });
      if (execution?.error) {
        throw new Error(execution.error.message || "Instagram relationship script failed.");
      }
      const result = execution?.result;
      if (!result || !["succeeded", "skipped", "failed"].includes(result.status)) {
        throw new Error("Instagram relationship script returned no structured result.");
      }
      return result;
    } finally {
      if (tab?.id) await closeTab(tab.id).catch(() => undefined);
    }
  };
}

export function composeLocalRuntime(chromeApi, log, {
  createStore = (options) => createFollowupStore(options),
  createTabs = (api) => createChromeTabGateway(api),
  createFollowers = (dependencies) => createInstagramFollowers(dependencies),
  createRelationshipGateway = (gateway) => createInstagramRelationshipGateway(gateway),
  createEngine = (dependencies) => createFollowupEngine({ ...dependencies, balancedCycles: true }),
} = {}) {
  const store = createStore({ storage: chromeApi.storage.local });
  const tabs = createTabs(chromeApi);
  const followers = createFollowers({
    openTabAndWait: tabs.openTabAndWait,
    executeScript: tabs.executeScript,
    closeTab: tabs.closeTab,
    log,
  });
  const performAction = createRelationshipGateway(tabs);
  const engine = createEngine({
    store,
    collectFollowers: followers.collectFollowers,
    collectOwnFollowerHandles: followers.collectOwnFollowerHandles,
    collectAndFollowFollowers: followers.collectAndFollowFollowers,
    performAction,
    schedule: (at) => chromeApi.alarms.create(
      INSTAGRAM_FOLLOWUP_NEXT_WORK,
      { when: at.getTime() },
    ),
    clearSchedule: () => chromeApi.alarms.clear(INSTAGRAM_FOLLOWUP_NEXT_WORK),
  });
  return { engine, store };
}

async function handleLocalIntent(message, { chromeApi, engine, store, health }) {
  const payload = message.payload || {};
  switch (message.type) {
    case "GET_FOLLOWUP_STATE": {
      const state = await engine.getState();
      return {
        ok: true,
        state,
        scheduler: await verifyScheduledAlarm(chromeApi, state),
        health: await health?.get(),
      };
    }
    case "ADD_SOURCE": {
      const source = await engine.addSource(payload.input, payload.limit);
      return { ok: true, source, state: await engine.getState() };
    }
    case "REMOVE_SOURCE": {
      await engine.removeSource(payload.sourceId);
      return { ok: true, state: await engine.getState() };
    }
    case "RUN_MANUAL_SOURCE": {
      let source;
      let sourceId = payload.sourceId;
      if (!sourceId) {
        source = await engine.addSource(payload.input, payload.limit);
        sourceId = source?.id;
      }
      if (!sourceId) throw new Error("Follow-up source was not found.");
      await engine.runManualSource(sourceId);
      return source
        ? { ok: true, source, state: await engine.getState() }
        : { ok: true, state: await engine.getState() };
    }
    case "SCAN_NOW": {
      await engine.scanNow(payload.sourceId);
      return { ok: true, state: await engine.getState() };
    }
    case "RUN_FOLLOW_BACK_REVIEW": {
      await engine.runFollowBackReview();
      return { ok: true, state: await engine.getState() };
    }
    case "RUN_NEXT_CYCLE_NOW": {
      await engine.runNextCycleNow();
      return { ok: true, state: await engine.getState() };
    }
    case "START_AUTO": {
      await engine.startAuto();
      return { ok: true, state: await engine.getState() };
    }
    case "PAUSE_AUTO": {
      await engine.pause();
      return { ok: true, state: await engine.getState() };
    }
    case "RESUME_AUTO": {
      await engine.resume();
      return { ok: true, state: await engine.getState() };
    }
    case "STOP_AUTO": {
      await engine.stop();
      return { ok: true, state: await engine.getState() };
    }
    case "SAVE_FOLLOWUP_SETTINGS": {
      const settings = payload.settings;
      await engine.saveSettings(settings);
      return { ok: true, state: await engine.getState() };
    }
    case "EXPORT_FOLLOWUP_STATE":
      return { ok: true, json: await store.exportJson() };
    case "RESET_FOLLOWUP_STATE": {
      await engine.stop();
      await store.reset();
      return { ok: true, state: await engine.getState() };
    }
    default:
      return null;
  }
}

export function installFollowupBackground({
  chromeApi = globalThis.chrome,
  engine: providedEngine,
  store: providedStore,
  health: providedHealth,
  log = (message) => console.info(`[Instagram Growth Autopilot] ${message}`),
  logError = (error) => console.error("[Instagram Growth Autopilot]", error),
} = {}) {
  if (!chromeApi?.runtime?.onMessage || !chromeApi?.alarms?.onAlarm) {
    throw new Error("Chrome runtime and alarms APIs are required.");
  }

  let engine = providedEngine;
  let store = providedStore;
  if (!engine || !store) ({ engine, store } = composeLocalRuntime(chromeApi, log));
  const health = providedHealth || createFollowupHealth({
    storage: chromeApi.storage.local,
    notify: async ({ title, message }) => {
      if (chromeApi.notifications?.create) await chromeApi.notifications.create({ type: "basic", iconUrl: "assets/icon128.png", title, message });
    },
  });
  const runWithHealth = async (operation) => {
    try {
      const value = await operation();
      await health.recordSuccess();
      return value;
    } catch (error) {
      const status = await health.recordFailure(error);
      if (status.nextRetryAt) await chromeApi.alarms.create(INSTAGRAM_GROWTH_RETRY, { when: Date.parse(status.nextRetryAt) });
      throw error;
    }
  };
  const runtimeReady = Promise.resolve().then(async () => {
    await chromeApi.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
    return runWithHealth(() => engine.reconcileStartup?.({ serviceWorkerActivated: true }));
  });

  try {
    const configured = chromeApi.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
    if (configured && typeof configured.catch === "function") configured.catch(logError);
  } catch (error) {
    logError(error);
  }

  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!LOCAL_MESSAGE_TYPES.has(message?.type)) return false;
    runtimeReady.then(async () => {
      if (message.type === "GET_FOLLOWUP_HEALTH") return { ok: true, health: await health.get() };
      if (message.type === "RETRY_FOLLOWUP_WORK") return runWithHealth(async () => {
        await engine.reconcileStartup?.({ serviceWorkerActivated: true });
        await engine.runDueWork();
        return { ok: true, state: await engine.getState(), health: await health.get() };
      });
      return handleLocalIntent(message, { chromeApi, engine, store, health });
    })
      .then(sendResponse)
      .catch((error) => {
        logError(error);
        sendResponse({ ok: false, error: errorMessage(error) });
      });
    return true;
  });

  chromeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === INSTAGRAM_FOLLOWUP_NEXT_WORK) {
      return runtimeReady.then(() => runWithHealth(() => engine.runDueWork())).catch(logError);
    }
    if (alarm?.name === INSTAGRAM_GROWTH_RETRY) {
      return runtimeReady.then(() => runWithHealth(async () => {
        await engine.reconcileStartup?.({ serviceWorkerActivated: true });
        return engine.runDueWork();
      })).catch(logError);
    }
    return undefined;
  });

  const reconcileStartup = (options) => {
    return runtimeReady.then(() => {
      if (typeof engine.reconcileStartup !== "function") return undefined;
      return runWithHealth(() => engine.reconcileStartup(options));
    }).catch(logError);
  };
  chromeApi.runtime.onStartup?.addListener(reconcileStartup);
  chromeApi.runtime.onInstalled?.addListener(reconcileStartup);
  return {
    get engine() { return engine; },
    get store() { return store; },
    ready: runtimeReady,
  };
}

if (globalThis.chrome?.runtime?.onMessage && globalThis.chrome?.alarms?.onAlarm) {
  installFollowupBackground();
}

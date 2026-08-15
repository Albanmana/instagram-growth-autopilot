import { createFollowupEngine } from "./followup-engine.js";
import { normalizeSourceInput } from "./followup-model.js";
import { createFollowupStore } from "./followup-store.js";
import { createFollowupRemoteStore } from "./followup-remote-store.js";
import { createFollowupServiceClient } from "./followup-service-client.js";
import { createFollowupConnectionStore } from "./followup-connection-store.js";
import { createLiveAcceleratedTest, LIVE_TEST_SOURCE_LIMIT } from "./live-accelerated-test.js";
import { performInstagramRelationshipAction } from "./instagram-follow-actions.js";
import { createInstagramFollowers } from "./instagram-followers.js";

export const INSTAGRAM_FOLLOWUP_NEXT_WORK = "INSTAGRAM_FOLLOWUP_NEXT_WORK";

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
  "PAIR_LOCAL_FOLLOWUP_SERVICE",
  "GET_LOCAL_FOLLOWUP_CONNECTION",
  "START_LIVE_ACCELERATED_TEST",
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

function isUninitializedRemoteState(state) {
  return Boolean(state)
    && state.automationEnabled !== true
    && Array.isArray(state.sources) && state.sources.length === 0
    && Array.isArray(state.candidates) && state.candidates.length === 0
    && Array.isArray(state.history) && state.history.length === 0
    && state.run?.phase === "idle"
    && Object.keys(state.settings || {}).length === 0;
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

export function composeRemoteRuntime(chromeApi, log, {
  connection,
  liveTest,
  createClient = (options) => createFollowupServiceClient(options),
  createStore = (client) => createFollowupRemoteStore(client),
  createTabs = (api) => createChromeTabGateway(api),
  createFollowers = (dependencies) => createInstagramFollowers(dependencies),
  createRelationshipGateway = (gateway) => createInstagramRelationshipGateway(gateway),
  createEngine = (dependencies) => createFollowupEngine({ ...dependencies, balancedCycles: true }),
} = {}) {
  const client = createClient(connection);
  const store = createStore(client);
  const tabs = createTabs(chromeApi);
  const followers = createFollowers({ openTabAndWait: tabs.openTabAndWait, executeScript: tabs.executeScript, closeTab: tabs.closeTab, log });
  const engine = createEngine({
    store,
    collectFollowers: followers.collectFollowers,
    collectOwnFollowerHandles: followers.collectOwnFollowerHandles,
    collectAndFollowFollowers: followers.collectAndFollowFollowers,
    performAction: createRelationshipGateway({
      ...tabs,
      ownHandle: connection.normalizedHandle,
      getOwnHandle: connection.normalizedHandle
        ? undefined
        : async () => (await client.getAccount()).normalizedHandle,
    }),
    schedule: (at, _name, options) => chromeApi.alarms.create(INSTAGRAM_FOLLOWUP_NEXT_WORK, {
      when: (liveTest ? liveTest.toAlarmTime(at, options) : at).getTime(),
    }),
    clearSchedule: () => chromeApi.alarms.clear(INSTAGRAM_FOLLOWUP_NEXT_WORK),
    ...(liveTest ? { now: () => liveTest.now() } : {}),
  });
  return { engine, store, client };
}

async function handleLocalIntent(message, { chromeApi, engine, store }) {
  const payload = message.payload || {};
  switch (message.type) {
    case "GET_FOLLOWUP_STATE": {
      const state = await engine.getState();
      return { ok: true, state, scheduler: await verifyScheduledAlarm(chromeApi, state) };
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
  remoteConnection,
  log = (message) => console.info(`[Instagram Growth Autopilot] ${message}`),
  logError = (error) => console.error("[Instagram Growth Autopilot]", error),
} = {}) {
  if (!chromeApi?.runtime?.onMessage || !chromeApi?.alarms?.onAlarm) {
    throw new Error("Chrome runtime and alarms APIs are required.");
  }

  let engine = providedEngine;
  let store = providedStore;
  if (!engine || !store) ({ engine, store } = remoteConnection
    ? composeRemoteRuntime(chromeApi, log, { connection: remoteConnection })
    : composeLocalRuntime(chromeApi, log));

  const connectionStore = chromeApi.storage?.local?.get && chromeApi.storage?.local?.set
    ? createFollowupConnectionStore({ storage: chromeApi.storage.local })
    : null;
  const liveTest = connectionStore ? createLiveAcceleratedTest({ storage: chromeApi.storage.local }) : null;
  let runtimeReady = Promise.resolve();
  if (!providedEngine && !providedStore && !remoteConnection && connectionStore) {
    runtimeReady = Promise.all([connectionStore.loadConnection(), liveTest.load()]).then(async ([connection]) => {
      if (!connection) return;
      ({ engine, store } = composeRemoteRuntime(chromeApi, log, { connection, liveTest }));
    }).catch((error) => { logError(error); });
  }

  async function pairLocalService({ baseUrl, pairingToken, handle }) {
    if (!connectionStore) throw new Error("Chrome local storage is required for pairing.");
    const pairingClient = createFollowupServiceClient({ baseUrl, pairingToken });
    const account = await pairingClient.provision(handle);
    const nextConnection = {
      baseUrl,
      pairingToken,
      accountId: account.accountId,
      normalizedHandle: account.normalizedHandle,
    };
    const previousState = await store.load();
    const nextRuntime = composeRemoteRuntime(chromeApi, log, { connection: nextConnection, liveTest });
    const snapshot = await nextRuntime.client.readEngineState();
    if (account.created || isUninitializedRemoteState(snapshot.state)) {
      await nextRuntime.client.replaceEngineState(snapshot.revision, previousState);
    }
    await connectionStore.saveConnection(nextConnection);
    engine = nextRuntime.engine;
    store = nextRuntime.store;
    await engine.reconcileStartup?.({ serviceWorkerActivated: true });
    const state = await engine.getState();
    return { ok: true, account, state };
  }

  try {
    const configured = chromeApi.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
    if (configured && typeof configured.catch === "function") configured.catch(logError);
  } catch (error) {
    logError(error);
  }

  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!LOCAL_MESSAGE_TYPES.has(message?.type)) return false;
    runtimeReady.then(async () => {
      if (message.type === "PAIR_LOCAL_FOLLOWUP_SERVICE") return pairLocalService(message.payload || {});
      if (message.type === "GET_LOCAL_FOLLOWUP_CONNECTION") {
        const connection = await connectionStore?.loadConnection();
        return { ok: true, connected: Boolean(connection), baseUrl: connection?.baseUrl, accountId: connection?.accountId };
      }
      if (message.type === "START_LIVE_ACCELERATED_TEST") {
        if (!connectionStore || !liveTest) throw new Error("Live accelerated testing requires the paired local service.");
        const sourceId = message.payload?.sourceId;
        const current = await engine.getState();
        const source = current.sources.find((candidate) => candidate.id === sourceId);
        if (!source) throw new Error("Choose an existing source for the live test.");
        await liveTest.start({ sourceId });
        await engine.startLiveTest(sourceId, LIVE_TEST_SOURCE_LIMIT);
        return { ok: true, state: await engine.getState(), liveTest: liveTest.getSession() };
      }
      if (message.type === "STOP_AUTO" && liveTest?.getSession()?.active) {
        const current = await engine.getState();
        if (current.run?.liveTestSourceId && typeof engine.stopLiveTest === "function") {
          await engine.stopLiveTest();
          await liveTest.stop();
          return { ok: true, state: await engine.getState() };
        }
      }
      return handleLocalIntent(message, { chromeApi, engine, store });
    })
      .then(sendResponse)
      .catch((error) => {
        logError(error);
        sendResponse({ ok: false, error: errorMessage(error) });
      });
    return true;
  });

  chromeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== INSTAGRAM_FOLLOWUP_NEXT_WORK) return undefined;
    return runtimeReady.then(() => engine.runDueWork()).catch(logError);
  });

  const reconcileStartup = (options) => {
    return runtimeReady.then(() => {
      if (typeof engine.reconcileStartup !== "function") return undefined;
      return engine.reconcileStartup(options);
    }).catch(logError);
  };
  chromeApi.runtime.onStartup?.addListener(reconcileStartup);
  chromeApi.runtime.onInstalled?.addListener(reconcileStartup);
  void reconcileStartup({ serviceWorkerActivated: true });

  return {
    get engine() { return engine; },
    get store() { return store; },
    ready: runtimeReady,
  };
}

if (globalThis.chrome?.runtime?.onMessage && globalThis.chrome?.alarms?.onAlarm) {
  installFollowupBackground();
}

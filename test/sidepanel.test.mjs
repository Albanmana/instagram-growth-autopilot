import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_FOLLOWUP_SETTINGS } from "../extension/followup-model.js";

class FakeClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set(element.className.split(/\s+/).filter(Boolean));
  }

  toggle(name, force) {
    if (force === true) this.values.add(name);
    else if (force === false) this.values.delete(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
    this.element.className = [...this.values].join(" ");
  }
}

class FakeElement {
  constructor(id = "", tagName = "div", attributes = new Map()) {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.hidden = attributes.has("hidden");
    this.disabled = attributes.has("disabled");
    this.value = attributes.get("value") || "";
    this.textContent = "";
    this.className = attributes.get("class") || "";
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
  }

  set innerHTML(_value) {
    this.children = [];
  }

  get innerHTML() {
    return "";
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  async trigger(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      await listener({ preventDefault() {}, ...event, target: this, currentTarget: this });
    }
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.clicked = true;
  }
}

function createDocument(html) {
  const elements = new Map();
  for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)([^>]*)>/gi)) {
    const attributes = new Map();
    for (const attribute of tag[2].matchAll(/([:\w-]+)(?:="([^"]*)")?/g)) {
      attributes.set(attribute[1], attribute[2] ?? "");
    }
    const id = attributes.get("id");
    if (id) elements.set(id, new FakeElement(id, tag[1], attributes));
  }
  const listeners = new Map();
  const created = [];
  return {
    visibilityState: "visible",
    created,
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tagName) {
      const element = new FakeElement("", tagName);
      created.push(element);
      return element;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    async trigger(type) {
      for (const listener of listeners.get(type) || []) await listener();
    },
  };
}

function source(id = "source-a", handle = "source") {
  return {
    id,
    profileUrl: `https://www.instagram.com/${handle}/`,
    limit: 200,
    status: "completed",
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:05:00.000Z",
  };
}

function dashboardState({
  automationEnabled = false,
  phase = "idle",
  pendingFollows = 0,
  dueUnfollows = 0,
  sources = [],
  history = [],
  candidates: providedCandidates = [],
  run = {},
} = {}) {
  const candidates = [...providedCandidates];
  for (let index = 0; index < pendingFollows; index += 1) {
    candidates.push({
      id: `instagram:pending-${index}`,
      handle: `pending_${index}`,
      status: "pending_follow",
      sourceIds: ["source-a"],
    });
  }
  for (let index = 0; index < dueUnfollows; index += 1) {
    candidates.push({
      id: `instagram:due-${index}`,
      handle: `due_${index}`,
      status: "pending_unfollow",
      unfollowDueAt: "2026-08-12T10:00:00.000Z",
      sourceIds: ["source-a"],
    });
  }
  return {
    version: 1,
    automationEnabled,
    settings: { ...DEFAULT_FOLLOWUP_SETTINGS },
    sources,
    candidates,
    run: {
      phase,
      activeBatch: phase === "running_batch"
        ? { kind: "follow", candidateIds: ["instagram:pending-0"] }
        : null,
      ...run,
    },
    history,
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withPanel({
  state = dashboardState(),
  confirm = true,
  exportJson = "{\"version\":1}",
  getStateHandler,
  intentHandler,
  now,
} = {}, testBody) {
  const sidepanelUrl = pathToFileURL(new URL("../extension/sidepanel.js", import.meta.url).pathname);
  const html = await readFile(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
  const original = {
    chrome: globalThis.chrome,
    document: globalThis.document,
    window: globalThis.window,
    URL: globalThis.URL,
    Date: globalThis.Date,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const document = createDocument(html);
  const messages = [];
  const intervals = [];
  const clearedIntervals = [];
  const objectUrls = [];
  const revokedUrls = [];
  let currentState = structuredClone(state);
  let confirmCalls = 0;
  let clock = now;

  globalThis.document = document;
  if (Number.isFinite(clock)) {
    const NativeDate = original.Date;
    globalThis.Date = class FakeDate extends NativeDate {
      constructor(value) {
        super(value === undefined ? clock : value);
      }

      static now() {
        return clock;
      }
    };
  }
  globalThis.window = {
    confirm(message) {
      confirmCalls += 1;
      assert.equal(message, "Reset all local sources, candidates, history, and settings?");
      return confirm;
    },
    addEventListener(type, listener) {
      document.addEventListener(type, listener);
    },
  };
  globalThis.setInterval = (callback, delay) => {
    const id = intervals.length + 1;
    intervals.push({ id, callback, delay });
    return id;
  };
  globalThis.clearInterval = (id) => clearedIntervals.push(id);
  globalThis.URL = {
    createObjectURL(blob) {
      objectUrls.push(blob);
      return "blob:local-export";
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
  };
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type !== "GET_FOLLOWUP_STATE" && intentHandler) {
          const response = await intentHandler(message, structuredClone(currentState));
          if (response?.state) currentState = structuredClone(response.state);
          return response;
        }
        switch (message.type) {
          case "GET_FOLLOWUP_STATE":
            if (getStateHandler) return getStateHandler(structuredClone(currentState));
            return { ok: true, state: structuredClone(currentState) };
          case "ADD_SOURCE": {
            const added = source("source-added", "added");
            currentState.sources.push(added);
            return { ok: true, source: added, state: structuredClone(currentState) };
          }
          case "REMOVE_SOURCE":
            currentState.sources = currentState.sources.filter(({ id }) => id !== message.payload.sourceId);
            return { ok: true, state: structuredClone(currentState) };
          case "SCAN_NOW":
            currentState.run.nextSourceScanAt = new Date().toISOString();
            currentState.run.sourceScanSourceId = message.payload.sourceId;
            return { ok: true, state: structuredClone(currentState) };
          case "START_AUTO":
            currentState.automationEnabled = true;
            currentState.run.phase = currentState.run.activeBatch ? "running_batch" : "idle";
            return { ok: true, state: structuredClone(currentState) };
          case "PAUSE_AUTO":
            currentState.run.phase = "paused";
            return { ok: true, state: structuredClone(currentState) };
          case "RESUME_AUTO":
            currentState.automationEnabled = true;
            currentState.run.phase = currentState.run.activeBatch ? "running_batch" : "idle";
            return { ok: true, state: structuredClone(currentState) };
          case "STOP_AUTO":
            currentState.automationEnabled = false;
            currentState.run.phase = "stopped";
            return { ok: true, state: structuredClone(currentState) };
          case "SAVE_FOLLOWUP_SETTINGS":
            currentState.settings = { ...currentState.settings, ...message.payload.settings };
            return { ok: true, state: structuredClone(currentState) };
          case "RESET_FOLLOWUP_STATE":
            currentState = dashboardState();
            return { ok: true, state: structuredClone(currentState) };
          case "EXPORT_FOLLOWUP_STATE":
            return { ok: true, json: exportJson };
          default:
            return { ok: true, state: structuredClone(currentState) };
        }
      },
    },
  };

  try {
    sidepanelUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
    await import(sidepanelUrl);
    await settle();
    await testBody({
      document,
      messages,
      intervals,
      clearedIntervals,
      objectUrls,
      revokedUrls,
      confirmCalls: () => confirmCalls,
      advanceTime(milliseconds) {
        clock += milliseconds;
      },
      setState(next) {
        currentState = structuredClone(next);
      },
    });
  } finally {
    await document.trigger("pagehide");
    Object.assign(globalThis, original);
  }
}

test("the four accessible sections default to Autopilot and switch one panel at a time", { concurrency: false }, async () => {
  await withPanel({}, async ({ document }) => {
    assert.equal(document.getElementById("section-nav").getAttribute("aria-label"), "Follow-up sections");
    assert.equal(document.getElementById("nav-autopilot").getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("autopilot-section").hidden, false);
    assert.equal(document.getElementById("sources-section").hidden, true);

    await document.getElementById("nav-sources").trigger("click");
    assert.equal(document.getElementById("nav-autopilot").getAttribute("aria-selected"), "false");
    assert.equal(document.getElementById("nav-sources").getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("autopilot-section").hidden, true);
    assert.equal(document.getElementById("sources-section").hidden, false);
    assert.equal(document.getElementById("growth-section").hidden, true);
    assert.equal(document.getElementById("settings-section").hidden, true);

    await document.getElementById("nav-sources").trigger("keydown", { key: "End" });
    assert.equal(document.getElementById("nav-settings").getAttribute("aria-selected"), "true");
    assert.equal(document.getElementById("nav-settings").getAttribute("tabindex"), "0");
    assert.equal(document.getElementById("nav-sources").getAttribute("tabindex"), "-1");
    assert.equal(document.getElementById("nav-settings").focused, true);
  });
});

test("Settings pairs a loopback service and migrates the current local state", { concurrency: false }, async () => {
  await withPanel({
    intentHandler: async (message, state) => {
      if (message.type !== "PAIR_LOCAL_FOLLOWUP_SERVICE") return undefined;
      return { ok: true, account: { normalizedHandle: "alban", created: true }, state };
    },
  }, async ({ document, messages }) => {
    await document.getElementById("nav-settings").trigger("click");
    document.getElementById("service-url-input").value = "http://127.0.0.1:4317";
    document.getElementById("service-handle-input").value = "@Alban";
    document.getElementById("service-token-input").value = "a-valid-local-pairing-token-value-123456";
    await document.getElementById("service-connect-button").trigger("click");
    const request = messages.find(({ type }) => type === "PAIR_LOCAL_FOLLOWUP_SERVICE");
    assert.deepEqual(request.payload, {
      baseUrl: "http://127.0.0.1:4317",
      handle: "@Alban",
      pairingToken: "a-valid-local-pairing-token-value-123456",
    });
    assert.equal(document.getElementById("service-token-input").value, "");
  });
});

test("Autopilot renders one phase-appropriate primary control and the next global work item", { concurrency: false }, async () => {
  const state = dashboardState({
    automationEnabled: true,
    phase: "waiting",
    run: {
      nextRelationshipReviewAt: "2026-08-14T12:00:00.000Z",
      nextSourceScanAt: "2026-08-14T13:00:00.000Z",
    },
  });
  await withPanel({ state }, async ({ document }) => {
    assert.equal(document.getElementById("start-auto-button").hidden, true);
    assert.equal(document.getElementById("pause-button").hidden, false);
    assert.equal(document.getElementById("resume-button").hidden, true);
    assert.equal(document.getElementById("stop-button").hidden, false);
    assert.match(document.getElementById("next-work").textContent, /follow-back review/i);
  });
});

test("the 48-hour timeline separates its persisted cycle from calculated forecasts", { concurrency: false }, async () => {
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  await withPanel({
    now,
    state: dashboardState({
      automationEnabled: true,
      phase: "waiting",
      candidates: [
        {
          id: "instagram:pending-review",
          handle: "pending_review",
          status: "followed",
          followedAt: "2026-08-13T12:00:00.000Z",
          sourceIds: ["source-a"],
        },
      ],
      run: {
        cycle: { dueAt: "2026-08-14T16:00:00.000Z", stage: "review" },
      },
    }),
  }, async ({ document }) => {
    const timeline = document.getElementById("operational-timeline");
    assert.equal(timeline.children.length, 12);
    assert.match(timeline.children[0].children[0].textContent, /Programmé/);
    assert.match(timeline.children[0].children[0].textContent, /Cycle global/);
    assert.match(timeline.children[1].children[0].textContent, /Prévision/);
    assert.match(timeline.children[1].children[1].textContent, /atteignent 48 h/);
  });
});

test("a future cycle gives queued follows its persisted countdown instead of a false ready state", { concurrency: false }, async () => {
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  await withPanel({
    now,
    state: dashboardState({
      automationEnabled: true,
      pendingFollows: 47,
      run: { cycle: { dueAt: "2026-08-14T16:00:00.000Z", stage: "review" } },
    }),
  }, async ({ document }) => {
    assert.equal(document.getElementById("next-work-state").textContent, "Scheduled");
    assert.match(document.getElementById("next-work").textContent, /47 follows queued/i);
    assert.equal(document.getElementById("next-work-countdown").textContent, "in 04:00:00");
    assert.match(document.getElementById("next-work-detail").textContent, /review.*collect.*unfollow.*follow/i);
    assert.equal(document.getElementById("run-next-cycle-button").hidden, false);
  });
});

test("the scheduled-cycle button advances only the persisted global cycle", { concurrency: false }, async () => {
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  await withPanel({
    now,
    state: dashboardState({
      automationEnabled: true,
      pendingFollows: 2,
      run: { cycle: { dueAt: "2026-08-14T16:00:00.000Z", stage: "review" } },
    }),
    intentHandler: async (message, state) => {
      assert.deepEqual(message, { type: "RUN_NEXT_CYCLE_NOW" });
      state.run.cycle.dueAt = new Date(now).toISOString();
      state.run.nextWorkAt = new Date(now).toISOString();
      return { ok: true, state };
    },
  }, async ({ document }) => {
    await document.getElementById("run-next-cycle-button").trigger("click");
    assert.equal(document.getElementById("run-next-cycle-button").hidden, true);
    assert.match(document.getElementById("next-work").textContent, /Follow @/);
  });
});

test("a scheduled cycle exposes that its Chrome alarm is armed", { concurrency: false }, async () => {
  const dueAt = "2026-08-14T16:00:00.000Z";
  const state = dashboardState({
    automationEnabled: true,
    pendingFollows: 2,
    run: { cycle: { dueAt, stage: "review" }, nextWorkAt: dueAt },
  });
  await withPanel({
    now: Date.parse("2026-08-14T12:00:00.000Z"),
    state,
    getStateHandler(current) {
      return { ok: true, state: current, scheduler: { status: "armed", plannedAt: dueAt, alarmAt: dueAt } };
    },
  }, async ({ document }) => {
    assert.equal(document.getElementById("next-work-alarm-status").textContent, "Chrome alarm armed for this cycle.");
    assert.equal(document.getElementById("next-work-alarm-status").hidden, false);
  });
});

test("the next-work card names the next persisted follow and counts down with its queued preview", { concurrency: false }, async () => {
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  const state = dashboardState({
    automationEnabled: true,
    phase: "running_batch",
    sources: [source("source-a", "noevarner.ai")],
    candidates: [
      { id: "instagram:alice", handle: "alice", status: "pending_follow", sourceIds: ["source-a"] },
      { id: "instagram:bob", handle: "bob", status: "pending_follow", sourceIds: ["source-a"] },
      { id: "instagram:carla", handle: "carla", status: "pending_follow", sourceIds: ["source-a"] },
      { id: "instagram:david", handle: "david", status: "pending_follow", sourceIds: ["source-a"] },
    ],
    run: {
      activeBatch: {
        kind: "follow",
        candidateIds: ["instagram:alice", "instagram:bob", "instagram:carla", "instagram:david"],
      },
      nextWorkAt: new Date(now + 10_000).toISOString(),
    },
  });
  await withPanel({ state, now }, async ({ document, intervals, advanceTime, clearedIntervals }) => {
    assert.equal(document.getElementById("next-work").textContent, "Follow @alice");
    assert.equal(document.getElementById("next-work-countdown").textContent, "in 00:10");
    assert.match(document.getElementById("next-work-detail").textContent, /@noevarner\.ai/i);
    assert.equal(document.getElementById("next-work-preview").children.length, 3);
    assert.equal(document.getElementById("next-work-preview").children[0].children[0].textContent, "Follow @bob");
    assert.equal(document.getElementById("next-work-preview").children[0].children[1].textContent, "after 1 action");
    assert.equal(document.getElementById("next-work-preview").children[2].children[0].textContent, "Follow @david");
    assert.equal(document.getElementById("next-work-preview").children[2].children[1].textContent, "after 3 actions");

    const countdown = intervals.find(({ delay }) => delay === 1_000);
    assert.ok(countdown, "expected a one-second countdown interval");
    advanceTime(1_000);
    await countdown.callback();
    assert.equal(document.getElementById("next-work-countdown").textContent, "in 00:09");

    document.visibilityState = "hidden";
    await document.trigger("visibilitychange");
    assert.ok(clearedIntervals.includes(countdown.id), "expected the countdown timer to stop while hidden");
  });
});

test("the next-work card counts down to the exact queued source scan", { concurrency: false }, async () => {
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  const state = dashboardState({
    automationEnabled: true,
    phase: "waiting",
    sources: [source("source-a", "noevarner.ai")],
    run: {
      nextSourceScanAt: new Date(now + 3_661_000).toISOString(),
      sourceScanSourceId: "source-a",
    },
  });
  await withPanel({ state, now }, async ({ document }) => {
    assert.equal(document.getElementById("next-work").textContent, "Scan @noevarner.ai");
    assert.equal(document.getElementById("next-work-countdown").textContent, "in 01:01:01");
    assert.match(document.getElementById("next-work-detail").textContent, /collecting.*visible followers/i);
    assert.equal(document.getElementById("next-work-state").textContent, "Scheduled");
  });
});

test("a long scheduled wait stays readable as days plus a ticking clock", { concurrency: false }, async () => {
  const now = Date.parse("2026-08-14T12:00:00.000Z");
  await withPanel({
    now,
    state: dashboardState({
      automationEnabled: true,
      phase: "waiting",
      sources: [source("source-a", "noevarner.ai")],
      run: {
        nextSourceScanAt: new Date(now + ((2 * 86_400_000) + 3_661_000)).toISOString(),
        sourceScanSourceId: "source-a",
      },
    }),
  }, async ({ document }) => {
    assert.equal(document.getElementById("next-work-countdown").textContent, "in 2d 01:01:01");
  });
});

test("a ready follow queue identifies its first account and says the global lane starts now", { concurrency: false }, async () => {
  await withPanel({
    state: dashboardState({
      automationEnabled: true,
      phase: "waiting",
      candidates: [
        { id: "instagram:alice", handle: "alice", status: "pending_follow", sourceIds: ["source-a"] },
        { id: "instagram:bob", handle: "bob", status: "pending_follow", sourceIds: ["source-a"] },
        { id: "instagram:carla", handle: "carla", status: "pending_follow", sourceIds: ["source-a"] },
      ],
    }),
  }, async ({ document, intervals }) => {
    assert.equal(document.getElementById("next-work").textContent, "Follow @alice · 3 waiting");
    assert.equal(document.getElementById("next-work-detail").textContent, "Starting in the global action lane now.");
    assert.equal(document.getElementById("next-work-countdown").hidden, true);
    assert.equal(document.getElementById("next-work-preview").children.length, 3);
    assert.equal(document.getElementById("next-work-preview").children[0].children[0].textContent, "Follow @alice");
    assert.equal(document.getElementById("next-work-preview").children[2].children[0].textContent, "Follow @carla");
    assert.equal(intervals.some(({ delay }) => delay === 1_000), false);
  });
});

test("active scanning never fabricates a countdown", { concurrency: false }, async () => {
  await withPanel({
    state: dashboardState({
      automationEnabled: true,
      phase: "collecting",
      sources: [source("source-a", "noevarner.ai")],
      run: { sourceScanSourceId: "source-a", nextWorkAt: "2099-01-01T00:00:00.000Z" },
    }),
  }, async ({ document, intervals }) => {
    assert.equal(document.getElementById("next-work").textContent, "Scanning @noevarner.ai");
    assert.equal(document.getElementById("next-work-countdown").hidden, true);
    assert.equal(document.getElementById("next-work-state").textContent, "Live");
    assert.equal(intervals.some(({ delay }) => delay === 1_000), false);
  });
});

test("persisted active work renders a live in-progress indicator", { concurrency: false }, async () => {
  await withPanel({
    state: dashboardState({
      automationEnabled: true,
      phase: "reviewing",
      run: { nextRelationshipReviewAt: "2026-08-14T12:00:00.000Z" },
    }),
  }, async ({ document }) => {
    assert.equal(document.getElementById("live-run-status").hidden, false);
    assert.match(document.getElementById("live-run-message").textContent, /reviewing follow-backs/i);
    assert.doesNotMatch(document.getElementById("live-run-message").textContent, /followed this run/i);
    assert.equal(document.getElementById("live-run-status").className.includes("is-running"), true);
  });
});

test("Autopilot start settles to an honest active state when persisted work is waiting", { concurrency: false }, async () => {
  await withPanel({}, async ({ document }) => {
    await document.getElementById("start-auto-button").trigger("click");
    assert.match(document.getElementById("live-run-message").textContent, /autopilot active/i);
    assert.doesNotMatch(document.getElementById("live-run-message").textContent, /starting.*…/i);
  });
});

test("a queued source scan becomes complete after its persisted active phase exits", { concurrency: false }, async () => {
  await withPanel({ state: dashboardState({ sources: [source()] }) }, async ({ document, intervals, setState }) => {
    const scanButton = document.getElementById("source-list").children[0].children[1].children[0];
    await scanButton.trigger("click");
    assert.match(document.getElementById("live-run-message").textContent, /scan queued/i);

    setState(dashboardState({ sources: [source()], phase: "collecting" }));
    await intervals[0].callback();
    assert.match(document.getElementById("live-run-message").textContent, /scanning sources/i);

    setState(dashboardState({ sources: [source()], automationEnabled: true, phase: "waiting" }));
    await intervals[0].callback();
    assert.match(document.getElementById("live-run-message").textContent, /scan finished/i);
  });
});

test("a source scan finishes when its persisted queue marker clears between polls", { concurrency: false }, async () => {
  let visibleState = dashboardState({ sources: [source()] });
  await withPanel({
    state: visibleState,
    getStateHandler: () => ({ ok: true, state: structuredClone(visibleState) }),
    intentHandler: async (message) => {
      assert.equal(message.type, "SCAN_NOW");
      visibleState = dashboardState({
        sources: [source()],
        run: {
          nextSourceScanAt: "2026-08-14T12:00:00.000Z",
          sourceScanSourceId: "source-a",
        },
      });
      return { ok: true, state: structuredClone(visibleState) };
    },
  }, async ({ document, intervals }) => {
    const scanButton = document.getElementById("source-list").children[0].children[1].children[0];
    await scanButton.trigger("click");
    assert.match(document.getElementById("live-run-message").textContent, /scan queued/i);

    visibleState = dashboardState({ sources: [source()], automationEnabled: true, phase: "waiting" });
    await intervals[0].callback();
    assert.match(document.getElementById("live-run-message").textContent, /scan finished/i);
  });
});

test("a legacy interrupted state never asks the operator to verify Instagram", { concurrency: false }, async () => {
  await withPanel({
    state: dashboardState({ automationEnabled: true, phase: "recovery_required" }),
  }, async ({ document, messages }) => {
    assert.doesNotMatch(document.getElementById("phase-pill").textContent, /verify/i);
    assert.doesNotMatch(document.getElementById("automation-status").textContent, /unavailable|verify/i);
    assert.match(document.getElementById("next-work").textContent, /resum/i);
    assert.equal(document.getElementById("pause-button").hidden, false);
    assert.equal(document.getElementById("stop-button").hidden, false);
    assert.equal(messages.some(({ type }) => ["START_AUTO", "PAUSE_AUTO", "RESUME_AUTO"].includes(type)), false);
  });
});

test("phase controls send only their matching local lifecycle intents", { concurrency: false }, async () => {
  await withPanel({ state: dashboardState() }, async ({ document, messages }) => {
    assert.equal(document.getElementById("start-auto-button").hidden, false);
    await document.getElementById("start-auto-button").trigger("click");
    assert.equal(messages.at(-1).type, "START_AUTO");
    assert.equal(document.getElementById("pause-button").hidden, false);

    await document.getElementById("pause-button").trigger("click");
    assert.equal(messages.at(-1).type, "PAUSE_AUTO");
    assert.equal(document.getElementById("resume-button").hidden, false);

    await document.getElementById("resume-button").trigger("click");
    assert.equal(messages.at(-1).type, "RESUME_AUTO");
    await document.getElementById("stop-button").trigger("click");
    assert.equal(messages.at(-1).type, "STOP_AUTO");
  });
});

test("a failed lifecycle intent leaves the last persisted render unchanged", { concurrency: false }, async () => {
  await withPanel({
    state: dashboardState(),
    intentHandler: async () => ({ ok: false, error: "Could not start." }),
  }, async ({ document }) => {
    await document.getElementById("start-auto-button").trigger("click");
    assert.match(document.getElementById("automation-status").textContent, /off/i);
    assert.equal(document.getElementById("phase-pill").textContent, "Ready");
    assert.equal(document.getElementById("start-auto-button").hidden, false);
    assert.match(document.getElementById("panel-status").textContent, /could not start/i);
  });
});

test("Sources sends add, remove, and Scan now intents and counts verified follows live", { concurrency: false }, async () => {
  const response = deferred();
  const initialHistory = [
    { handle: "previous", action: "follow", status: "succeeded", at: "2026-08-14T11:59:00.000Z" },
  ];
  let visibleState = dashboardState({ sources: [source()], history: initialHistory });
  await withPanel({
    state: visibleState,
    getStateHandler: () => ({ ok: true, state: structuredClone(visibleState) }),
    intentHandler: async (message) => {
      if (message.type !== "SCAN_NOW") return { ok: true, state: structuredClone(visibleState) };
      await response.promise;
      return { ok: true, state: structuredClone(visibleState) };
    },
  }, async ({ document, messages, intervals }) => {
    const sourceActions = document.getElementById("source-list").children[0].children[1];
    const scanButton = sourceActions.children[0];
    const scan = scanButton.trigger("click");
    await settle();
    assert.deepEqual(messages.at(-1), { type: "SCAN_NOW", payload: { sourceId: "source-a" } });
    assert.equal(document.getElementById("live-run-status").hidden, false);
    assert.match(document.getElementById("live-run-message").textContent, /0 followed this run/i);

    visibleState = dashboardState({
      sources: [source()],
      history: [
        ...initialHistory,
        { handle: "confirmed", action: "follow", status: "succeeded", at: "2026-08-14T12:00:00.000Z" },
        { handle: "skipped", action: "follow", status: "skipped", at: "2026-08-14T12:00:01.000Z" },
      ],
    });
    await intervals[0].callback();
    assert.match(document.getElementById("live-run-message").textContent, /1 followed this run/i);

    response.resolve();
    await scan;
    assert.match(document.getElementById("live-run-message").textContent, /scan queued/i);

    const liveTestButton = document.getElementById("source-list").children[0].children[1].children[1];
    await liveTestButton.trigger("click");
    assert.deepEqual(messages.at(-1), { type: "START_LIVE_ACCELERATED_TEST", payload: { sourceId: "source-a" } });

    const removeButton = document.getElementById("source-list").children[0].children[1].children[2];
    await removeButton.trigger("click");
    assert.deepEqual(messages.at(-1), { type: "REMOVE_SOURCE", payload: { sourceId: "source-a" } });

    document.getElementById("source-input").value = "@added";
    await document.getElementById("add-source-button").trigger("click");
    assert.deepEqual(messages.at(-1), {
      type: "ADD_SOURCE",
      payload: { input: "@added", limit: 200 },
    });
  });
});

test("persisted candidates and history drive weekly growth and lifecycle metrics", { concurrency: false }, async () => {
  const recent = new Date(Date.now() - (24 * 60 * 60 * 1_000)).toISOString();
  const state = dashboardState({
    candidates: [
      { id: "instagram:alice", handle: "alice", status: "followed", followBackStatus: "confirmed" },
      { id: "instagram:bob", handle: "bob", status: "followed", followBackStatus: "unknown" },
      { id: "instagram:carol", handle: "carol", status: "pending_unfollow", followBackStatus: "unknown", unfollowDueAt: "2000-01-01T00:00:00.000Z" },
    ],
    history: [
      { candidateId: "instagram:alice", action: "follow", status: "succeeded", at: recent },
      { candidateId: "instagram:bob", action: "follow", status: "succeeded", at: recent },
      { candidateId: "instagram:old", action: "follow", status: "succeeded", at: "2020-01-01T00:00:00.000Z" },
    ],
  });
  await withPanel({ state }, async ({ document }) => {
    assert.equal(document.getElementById("weekly-follow-count").textContent, "2");
    assert.equal(document.getElementById("confirmed-followback-count").textContent, "1");
    assert.equal(document.getElementById("conversion-rate").textContent, "50%");
    assert.equal(document.getElementById("waiting-count").textContent, "1");
    assert.equal(document.getElementById("due-unfollow-count").textContent, "1");
    assert.match(document.getElementById("history-list").children[0].textContent, /old/i);
  });
});

test("Growth refresh queues a manual follow-back review without a source scan", { concurrency: false }, async () => {
  const response = deferred();
  await withPanel({
    state: dashboardState(),
    intentHandler: async (message, state) => {
      assert.equal(message.type, "RUN_FOLLOW_BACK_REVIEW");
      await response.promise;
      return { ok: true, state };
    },
  }, async ({ document, messages }) => {
    await document.getElementById("nav-growth").trigger("click");
    const refresh = document.getElementById("follow-back-review-button");
    const pending = refresh.trigger("click");
    await settle();
    assert.equal(refresh.disabled, true);
    assert.deepEqual(messages.at(-1), { type: "RUN_FOLLOW_BACK_REVIEW" });
    response.resolve();
    await pending;
    assert.equal(refresh.disabled, false);
  });
});

test("Autopilot hides the optional calendar while retaining Next global work", { concurrency: false }, async () => {
  await withPanel({
    state: dashboardState({
      automationEnabled: true,
      phase: "waiting",
      run: { cycle: { dueAt: "2026-08-16T12:00:00.000Z", stage: "review" } },
    }),
  }, async ({ document }) => {
    assert.equal(document.getElementById("next-work").hidden, false);
    assert.equal(document.getElementById("operational-timeline-card").hidden, true);
  });
});

test("Settings persists J+2 and J+7 retention with advanced timing and validates locally", { concurrency: false }, async () => {
  const state = dashboardState();
  state.settings.batchSize = 25;
  await withPanel({ state }, async ({ document, messages }) => {
    assert.equal(document.getElementById("batch-size-input").value, "25");
    assert.equal(document.getElementById("follow-back-unfollow-delay-days-input").value, "7");
    assert.equal(document.getElementById("source-rescan-hours-input").value, "6");
    assert.match(document.getElementById("advanced-settings").getAttribute("aria-label"), /advanced timing/i);

    document.getElementById("unfollow-delay-days-input").value = "3";
    document.getElementById("follow-back-unfollow-delay-days-input").value = "9";
    document.getElementById("source-rescan-hours-input").value = "12";
    await document.getElementById("settings-save-button").trigger("click");
    assert.deepEqual(messages.at(-1), {
      type: "SAVE_FOLLOWUP_SETTINGS",
      payload: { settings: { ...state.settings, unfollowDelayDays: 3, followBackUnfollowDelayDays: 9, sourceRescanHours: 12 } },
    });

    const saveCount = messages.filter(({ type }) => type === "SAVE_FOLLOWUP_SETTINGS").length;
    document.getElementById("action-delay-min-seconds-input").value = "30";
    document.getElementById("action-delay-max-seconds-input").value = "10";
    await document.getElementById("settings-save-button").trigger("click");
    assert.equal(messages.filter(({ type }) => type === "SAVE_FOLLOWUP_SETTINGS").length, saveCount);
    assert.match(document.getElementById("panel-status").textContent, /minimum.*maximum/i);
  });
});

test("polls state while visible and stops polling when the panel is hidden", { concurrency: false }, async () => {
  await withPanel({}, async ({ document, messages, intervals, clearedIntervals }) => {
    assert.equal(messages.filter(({ type }) => type === "GET_FOLLOWUP_STATE").length, 1);
    assert.equal(intervals.length, 1);
    await intervals[0].callback();
    assert.equal(messages.filter(({ type }) => type === "GET_FOLLOWUP_STATE").length, 2);

    document.visibilityState = "hidden";
    await document.trigger("visibilitychange");
    assert.deepEqual(clearedIntervals, [intervals[0].id]);
  });
});

test("a stale poll response cannot overwrite a completed control intent", { concurrency: false }, async () => {
  const stalePoll = deferred();
  let reads = 0;
  const initial = dashboardState({ automationEnabled: true, phase: "waiting" });
  await withPanel({
    state: initial,
    getStateHandler(current) {
      reads += 1;
      return reads === 1 ? { ok: true, state: current } : stalePoll.promise;
    },
  }, async ({ document, intervals }) => {
    const polling = intervals[0].callback();
    await document.getElementById("stop-button").trigger("click");
    assert.match(document.getElementById("automation-status").textContent, /off/i);

    stalePoll.resolve({ ok: true, state: initial });
    await polling;
    assert.match(document.getElementById("automation-status").textContent, /off/i);
    assert.equal(document.getElementById("start-auto-button").hidden, false);
  });
});

test("export stays local and reset requires the exact confirmation", { concurrency: false }, async () => {
  await withPanel({ confirm: false, exportJson: "{\"private\":\"local\"}" }, async ({
    document,
    messages,
    objectUrls,
    revokedUrls,
    confirmCalls,
  }) => {
    await document.getElementById("export-button").trigger("click");
    assert.equal(messages.at(-1).type, "EXPORT_FOLLOWUP_STATE");
    assert.equal(objectUrls.length, 1);
    assert.equal(await objectUrls[0].text(), "{\"private\":\"local\"}");
    const link = document.created.find(({ tagName }) => tagName === "A");
    assert.match(link.download, /^instagram-followup-export-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(link.clicked, true);
    assert.deepEqual(revokedUrls, ["blob:local-export"]);

    await document.getElementById("reset-button").trigger("click");
    assert.equal(confirmCalls(), 1);
    assert.equal(messages.some(({ type }) => type === "RESET_FOLLOWUP_STATE"), false);
  });

  await withPanel({ confirm: true }, async ({ document, messages }) => {
    await document.getElementById("reset-button").trigger("click");
    assert.equal(messages.at(-1).type, "RESET_FOLLOWUP_STATE");
  });
});

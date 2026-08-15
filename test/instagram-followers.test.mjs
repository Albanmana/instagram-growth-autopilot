import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectProfileListFromDom,
  createInstagramFollowers,
  extractInstagramProfileListNetworkProfiles,
  openProfileListModal,
} from "../extension/instagram-followers.js";

function scriptedFollowers(items, debug = {}) {
  const results = [
    [{ result: { ok: true, dialogToken: "followers-test-dialog" } }],
    [{ result: { expanded: false, reason: "expand-trigger-not-found" } }],
    [{
      result: {
        items: items.map((item) => typeof item === "string"
          ? { username: item, name: "" }
          : item),
        debug: {
          scannedCount: items.length,
          idlePasses: 1,
          ownerOnlyListNotice: false,
          othersSummaryText: "",
          ...debug,
        },
      },
    }],
  ];

  return async () => results.shift();
}

function browserDomFollowers(items) {
  class FakeElement {
    constructor({ href = "", text = "", row = null, role = "", dialogToken = "" } = {}) {
      this.href = href;
      this.textContent = text;
      this.row = row;
      this.parentElement = row;
      this.innerText = "";
      this.attributes = new Map();
      if (href) this.attributes.set("href", href);
      if (role) this.attributes.set("role", role);
      if (dialogToken) this.attributes.set("data-instagram-followup-dialog", dialogToken);
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }

    getBoundingClientRect() {
      return { width: 100, height: 20 };
    }

    closest(selector) {
      if (selector.includes("div")) return this.row;
      return null;
    }

    querySelectorAll() {
      return [];
    }
  }

  const anchors = items.map(({ username, name = "" }) => {
    const row = new FakeElement({ role: "listitem" });
    const anchor = new FakeElement({ href: `/${username}/`, row });
    row.querySelectorAll = (selector) => {
      if (selector === "a[href]") return [anchor];
      if (selector === "button, [role='button']") return [new FakeElement({ text: "Follow" })];
      return [
        new FakeElement({ text: username }),
        new FakeElement({ text: name }),
      ];
    };
    return anchor;
  });
  const dialog = new FakeElement({ role: "dialog", dialogToken: "followers-test-dialog" });
  dialog.querySelectorAll = (selector) => selector === "a[href]" ? anchors : [];

  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousWindow = globalThis.window;
  globalThis.HTMLElement = FakeElement;
  globalThis.window = {
    location: {
      hostname: "www.instagram.com",
      pathname: "/source/followers/",
      origin: "https://www.instagram.com",
    },
  };
  globalThis.document = {
    querySelector: () => dialog,
    querySelectorAll: () => [dialog],
  };

  let call = 0;
  return {
    executeScript: async (details) => {
      call += 1;
      if (call === 1) return [{ result: { ok: true, dialogToken: "followers-test-dialog" } }];
      if (call === 2) return [{ result: { expanded: false, reason: "expand-trigger-not-found" } }];
      return [{ result: await details.func(...details.args) }];
    },
    restore() {
      globalThis.document = previousDocument;
      globalThis.HTMLElement = previousHTMLElement;
      globalThis.window = previousWindow;
    },
  };
}

class InjectedElement {
  constructor(tagName, { href = "", text = "", role = "", visible = true, overflowY = "visible" } = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.parentElement = null;
    this.children = [];
    this.visible = visible;
    this.attributes = new Map();
    this.clicks = 0;
    this.onClick = null;
    this.innerText = text;
    this.clientHeight = 400;
    this.scrollHeight = 400;
    this.scrollTop = 0;
    this.overflowY = overflowY;
    this.onDispatch = null;
    if (href) this.attributes.set("href", href);
    if (role) this.attributes.set("role", role);
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getBoundingClientRect() {
    return this.visible ? { width: 100, height: 24 } : { width: 0, height: 0 };
  }

  querySelectorAll(selector) {
    return injectedDescendants(this).filter((element) => injectedMatches(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (injectedMatches(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  click() {
    this.clicks += 1;
    this.onClick?.();
  }

  dispatchEvent(event) {
    this.onDispatch?.(event);
  }
}

function injectedDescendants(root) {
  return root.children.flatMap((child) => [child, ...injectedDescendants(child)]);
}

function injectedMatches(element, selector) {
  return selector.split(",").some((part) => {
    const value = part.trim();
    if (value === "*") return true;
    if (value === "a") return element.tagName === "A";
    if (value === "a[href]") return element.tagName === "A" && element.getAttribute("href") != null;
    if (value === "button") return element.tagName === "BUTTON";
    if (value === "span") return element.tagName === "SPAN";
    if (value === "div") return element.tagName === "DIV";
    if (value === "header") return element.tagName === "HEADER";
    if (value === "section") return element.tagName === "SECTION";
    if (value === "main") return element.tagName === "MAIN";
    if (value === "nav") return element.tagName === "NAV";
    if (value === "li") return element.tagName === "LI";
    if (value === "article") return element.tagName === "ARTICLE";
    if (value === "[role='button']") return element.getAttribute("role") === "button";
    if (value === "[role='listitem']") return element.getAttribute("role") === "listitem";
    if (value === "span[role='link']") return element.tagName === "SPAN" && element.getAttribute("role") === "link";
    if (value === "div[role='button']") return element.tagName === "DIV" && element.getAttribute("role") === "button";
    if (value === "div[role='dialog']") return element.tagName === "DIV" && element.getAttribute("role") === "dialog";
    if (value === "section[role='dialog']") return element.tagName === "SECTION" && element.getAttribute("role") === "dialog";
    return false;
  });
}

function installInjectedDom({ pathname = "/source/", roots }) {
  const previous = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    window: globalThis.window,
    setTimeout: globalThis.setTimeout,
  };
  const location = {
    hostname: "www.instagram.com",
    pathname,
    origin: "https://www.instagram.com",
  };
  globalThis.HTMLElement = InjectedElement;
  globalThis.window = {
    location,
    getComputedStyle: (element) => ({ overflowY: element.overflowY }),
  };
  globalThis.document = {
    querySelectorAll(selector) {
      return roots.flatMap((root) => [root, ...injectedDescendants(root)])
        .filter((element) => injectedMatches(element, selector));
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
  };
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 1;
  };
  return {
    location,
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}

function injectedExecutor(details) {
  return Promise.resolve(details.func(...(details.args || [])))
    .then((result) => [{ result }]);
}

function followerRow(href, handle, name = "") {
  return new InjectedElement("div", { role: "listitem" }).append(
    new InjectedElement("a", { href, text: handle }),
    new InjectedElement("span", { text: handle }),
    new InjectedElement("span", { text: name }),
    new InjectedElement("button", { text: "Follow" }),
  );
}

function browserModalWithRows(rows, {
  revealOnScroll = [],
  delayedRows = [],
  delayedRowsMs = 10,
  limitationText = "",
  semanticRows = true,
} = {}) {
  const roots = [];
  const trigger = new InjectedElement("a", { href: "/source/followers/", text: "20 followers" });
  const dialog = new InjectedElement("div", { role: "dialog" });
  const list = new InjectedElement("div", { overflowY: revealOnScroll.length ? "auto" : "visible" });
  if (revealOnScroll.length) list.clientHeight = 100;
  dialog.innerText = limitationText;
  const dom = installInjectedDom({ roots });
  roots.push(new InjectedElement("main").append(new InjectedElement("header").append(trigger)));

  const appendRows = (items) => {
    for (const { handle, displayName = "", label, afterClickLabel, controls = 1, link = true, replaceOnClick = false, wrappedHandleText = false } of items) {
      const row = new InjectedElement("div", semanticRows ? { role: "listitem" } : {});
      if (link) row.append(new InjectedElement("a", { href: `/${handle}/`, text: handle }));
      if (wrappedHandleText) {
        row.append(new InjectedElement("div", { text: `${handle}${displayName}` }).append(
          new InjectedElement("span", { text: handle }),
          new InjectedElement("span", { text: displayName }),
        ));
      } else {
        row.append(
          new InjectedElement("span", { text: handle }),
          new InjectedElement("span", { text: displayName }),
        );
      }
      for (let index = 0; index < controls; index += 1) {
        const control = new InjectedElement("button", { text: label });
        if (afterClickLabel) control.onClick = () => {
          if (replaceOnClick) {
            const replacement = new InjectedElement("button", { text: afterClickLabel });
            row.children = row.children.map((child) => child === control ? replacement : child);
            replacement.parentElement = row;
            control.parentElement = null;
          } else {
            control.textContent = afterClickLabel;
          }
        };
        row.append(control);
      }
      list.append(row);
    }
  };
  appendRows(rows);
  dialog.append(list);
  let scrollEvents = 0;
  list.onDispatch = () => {
    scrollEvents += 1;
    if (scrollEvents === 1) appendRows(revealOnScroll);
  };

  trigger.onClick = () => {
    roots.push(dialog);
    if (delayedRows.length) setTimeout(() => appendRows(delayedRows), delayedRowsMs);
  };

  return {
    openTabAndWait: async () => ({ id: 55 }),
    executeScript: injectedExecutor,
    closeTab: async () => {},
    log: () => {},
    scrollEvents: () => scrollEvents,
    restore: () => dom.restore(),
  };
}

test("collects only unique normalized follower handles and closes the profile tab", async () => {
  const closed = [];
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 42 }),
    executeScript: scriptedFollowers([
      { username: "Alice", name: "Alice A." },
      { username: "@alice", name: "Duplicate Alice" },
      { username: " bob ", name: "Bob B." },
    ]),
    closeTab: async (id) => closed.push(id),
    log: () => {},
  });

  const result = await adapter.collectFollowers({
    profileUrl: "https://instagram.com/source/?hl=en",
    limit: 200,
  });

  assert.deepEqual(result, {
    candidates: [
      { handle: "alice", profileUrl: "https://www.instagram.com/alice/", displayName: "Alice A." },
      { handle: "bob", profileUrl: "https://www.instagram.com/bob/", displayName: "Bob B." },
    ],
    warning: null,
  });
  assert.deepEqual(closed, [42]);
});

test("collects an exact semantic Followers row even when Instagram omits its relationship control", async () => {
  const browser = browserModalWithRows([
    { handle: "pitchforkvault", displayName: "Pitchfork Vault", controls: 0 },
  ]);
  const adapter = createInstagramFollowers(browser);

  try {
    const result = await adapter.collectFollowers({
      profileUrl: "https://www.instagram.com/source/",
      limit: 20,
    });
    assert.deepEqual(result.candidates, [{
      handle: "pitchforkvault",
      profileUrl: "https://www.instagram.com/pitchforkvault/",
      displayName: "Pitchfork Vault",
    }]);
  } finally {
    browser.restore();
  }
});

test("collectOwnFollowerHandles returns canonical handles from the bound own Followers dialog", async () => {
  const opened = [];
  const closed = [];
  const calls = [];
  const responses = [
    [{ result: { profileUrl: "https://www.instagram.com/owner/" } }],
    [{ result: { ok: true, dialogToken: "followers-test-dialog" } }],
    [{ result: { expanded: false, reason: "expand-trigger-not-found" } }],
    [{ result: {
      items: [
        { username: "Alice", name: "Alice A." },
        { username: "@alice", name: "Duplicate Alice" },
        { username: " BOB ", name: "Bob B." },
      ],
      debug: {
        scannedCount: 3,
        idlePasses: 1,
        ownerOnlyListNotice: false,
        othersSummaryText: "",
      },
    } }],
  ];
  const adapter = createInstagramFollowers({
    openTabAndWait: async (url) => {
      opened.push(url);
      return { id: opened.length };
    },
    executeScript: async (details) => {
      calls.push(details.args || []);
      return responses.shift();
    },
    closeTab: async (id) => closed.push(id),
    log: () => {},
  });

  const result = await adapter.collectOwnFollowerHandles({ limit: 30 });

  assert.deepEqual(result, { handles: ["alice", "bob"], warning: null });
  assert.deepEqual(opened, [
    "https://www.instagram.com/",
    "https://www.instagram.com/owner/",
  ]);
  assert.deepEqual(calls, [
    [],
    ["followers", "https://www.instagram.com/owner/"],
    ["https://www.instagram.com/owner/", "followers-test-dialog"],
    ["followers", 30, "https://www.instagram.com/owner/", "followers-test-dialog"],
  ]);
  assert.deepEqual(closed, [2, 1]);
});

test("collectOwnFollowerHandles preserves a preview warning instead of using omissions as negative evidence", async () => {
  const responses = [
    [{ result: { profileUrl: "https://www.instagram.com/owner/" } }],
    [{ result: { ok: true, dialogToken: "followers-test-dialog" } }],
    [{ result: { expanded: false, reason: "expand-trigger-not-found" } }],
    [{ result: {
      items: [{ username: "alice", name: "Alice A." }],
      debug: {
        scannedCount: 1,
        idlePasses: 1,
        ownerOnlyListNotice: false,
        othersSummaryText: "and 42 others",
      },
    } }],
  ];
  const adapter = createInstagramFollowers({
    openTabAndWait: async (_url, _active) => ({ id: 9 }),
    executeScript: async () => responses.shift(),
    closeTab: async () => {},
    log: () => {},
  });

  const result = await adapter.collectOwnFollowerHandles({ limit: 30 });

  assert.deepEqual(result, {
    handles: ["alice"],
    warning: "Instagram limited this followers list. Instagram is showing a preview list (and 42 others) instead of the full followers list.",
  });
});

test("collectOwnFollowerHandles warns when the review reaches its configured limit", async () => {
  const responses = [
    [{ result: { profileUrl: "https://www.instagram.com/owner/" } }],
    [{ result: { ok: true, dialogToken: "followers-test-dialog" } }],
    [{ result: { expanded: false, reason: "expand-trigger-not-found" } }],
    [{ result: {
      items: [
        { username: "alice", name: "Alice A." },
        { username: "bob", name: "Bob B." },
      ],
      debug: {
        scannedCount: 2,
        idlePasses: 1,
        ownerOnlyListNotice: false,
        othersSummaryText: "",
      },
    } }],
  ];
  const closed = [];
  const adapter = createInstagramFollowers({
    openTabAndWait: async (_url, _active) => ({ id: closed.length + 1 }),
    executeScript: async () => responses.shift(),
    closeTab: async (id) => closed.push(id),
    log: () => {},
  });

  const result = await adapter.collectOwnFollowerHandles({ limit: 2 });

  assert.deepEqual(result, {
    handles: ["alice", "bob"],
    warning: "Instagram follower review reached its 2-profile limit. The result may be incomplete; do not treat omitted handles as negative evidence.",
  });
  assert.deepEqual(closed, [1, 1]);
});

test("deduplicates normalized handles before applying the collection limit", async () => {
  const browser = browserDomFollowers([
    { username: "Alice", name: "Alice A." },
    { username: "alice", name: "Duplicate Alice" },
    { username: "bob", name: "Bob B." },
  ]);
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 43 }),
    executeScript: browser.executeScript,
    closeTab: async () => {},
    log: () => {},
  });

  try {
    const result = await adapter.collectFollowers({ profileUrl: "source", limit: 2 });
    assert.deepEqual(result.candidates.map(({ handle }) => handle), ["alice", "bob"]);
  } finally {
    browser.restore();
  }
});

test("accepts intercepted profile-list payloads for followers and following without external effects", () => {
  const payload = {
    users: [{
      username: "Alice",
      full_name: "Alice Network",
      biography: "Founder",
      follower_count: 42,
    }],
  };

  for (const sourceType of ["followers", "following"]) {
    assert.deepEqual(
      [...extractInstagramProfileListNetworkProfiles(sourceType, payload)],
      [["alice", {
        name: "Alice Network",
        bio: "Founder",
        followers_count: 42,
        posts_count: null,
        is_private: null,
        is_verified: null,
        is_business_account: null,
        external_links: "",
      }]],
    );
  }

  assert.deepEqual([...extractInstagramProfileListNetworkProfiles("comments", payload)], []);
});

test("preserves the owner-only followers warning", async () => {
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 7 }),
    executeScript: scriptedFollowers(["alice"], {
      ownerOnlyListNotice: true,
      othersSummaryText: "and 1,234 others",
    }),
    closeTab: async () => {},
    log: () => {},
  });

  const result = await adapter.collectFollowers({ profileUrl: "source", limit: 200 });

  assert.equal(
    result.warning,
    "Instagram limited this followers list. Only the account owner can see the full followers list for this profile.",
  );
});

test("preserves the followers preview warning", async () => {
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 8 }),
    executeScript: scriptedFollowers(["alice"], { othersSummaryText: "and 42 others" }),
    closeTab: async () => {},
    log: () => {},
  });

  const result = await adapter.collectFollowers({ profileUrl: "@source", limit: 200 });

  assert.equal(
    result.warning,
    "Instagram limited this followers list. Instagram is showing a preview list (and 42 others) instead of the full followers list.",
  );
});

test("closes the profile tab when follower collection fails", async () => {
  const closed = [];
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 99 }),
    executeScript: async () => {
      throw new Error("Instagram changed its modal");
    },
    closeTab: async (id) => closed.push(id),
    log: () => {},
  });

  await assert.rejects(
    adapter.collectFollowers({ profileUrl: "source", limit: 200 }),
    /Instagram changed its modal/,
  );
  assert.deepEqual(closed, [99]);
});

test("closes the profile tab when collection is aborted", async () => {
  const closed = [];
  const controller = new AbortController();
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 101 }),
    executeScript: async () => {
      controller.abort();
      return [{ result: { ok: true } }];
    },
    closeTab: async (id) => closed.push(id),
    log: () => {},
  });

  await assert.rejects(
    adapter.collectFollowers({ profileUrl: "source", limit: 200, signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.deepEqual(closed, [101]);
});

test("opens the followers dialog only from the exact canonical source trigger", { concurrency: false }, async () => {
  const roots = [];
  const header = new InjectedElement("header");
  const wrongTrigger = new InjectedElement("a", { href: "/other/followers/", text: "10 followers" });
  const sourceTrigger = new InjectedElement("a", { href: "/source/followers/", text: "20 followers" });
  header.append(wrongTrigger, sourceTrigger);
  roots.push(new InjectedElement("main").append(header));
  const dom = installInjectedDom({ roots });

  wrongTrigger.onClick = () => {
    dom.location.pathname = "/other/followers/";
    roots.push(new InjectedElement("div", { role: "dialog" }));
  };
  let openedDialog = null;
  sourceTrigger.onClick = () => {
    dom.location.pathname = "/source/followers/";
    openedDialog = new InjectedElement("div", { role: "dialog" });
    roots.push(openedDialog);
  };

  try {
    const opened = await openProfileListModal(
      injectedExecutor,
      41,
      "followers",
      "https://www.instagram.com/source/",
    );

    assert.equal(wrongTrigger.clicks, 0);
    assert.equal(sourceTrigger.clicks, 1);
    assert.match(opened.dialogToken, /^followers-/);
    assert.equal(openedDialog.getAttribute("data-instagram-followup-dialog"), opened.dialogToken);
  } finally {
    dom.restore();
  }
});

test("opens an exact followers trigger rendered outside semantic header or main containers", { concurrency: false }, async () => {
  const trigger = new InjectedElement("a", { href: "/noevarner.ai/followers/", text: "104 k followers" });
  const roots = [new InjectedElement("div").append(trigger)];
  const dom = installInjectedDom({ pathname: "/noevarner.ai/", roots });
  trigger.onClick = () => {
    dom.location.pathname = "/noevarner.ai/followers/";
    roots.push(new InjectedElement("div", { role: "dialog" }));
  };

  try {
    const opened = await openProfileListModal(
      injectedExecutor,
      48,
      "followers",
      "https://www.instagram.com/noevarner.ai/",
    );
    assert.equal(trigger.clicks, 1);
    assert.match(opened.dialogToken, /^followers-/);
  } finally {
    dom.restore();
  }
});

test("falls back to the visible followers-count control when Instagram does not expose its canonical href", { concurrency: false }, async () => {
  const trigger = new InjectedElement("button", { text: "104 k followers" });
  const roots = [new InjectedElement("div").append(trigger)];
  const dom = installInjectedDom({ pathname: "/noevarner.ai/", roots });
  trigger.onClick = () => {
    roots.push(new InjectedElement("div", { role: "dialog" }));
  };

  try {
    const opened = await openProfileListModal(
      injectedExecutor,
      49,
      "followers",
      "https://www.instagram.com/noevarner.ai/",
    );
    assert.equal(trigger.clicks, 1);
    assert.match(opened.dialogToken, /^followers-/);
  } finally {
    dom.restore();
  }
});

test("refuses a pre-existing dialog instead of treating it as the clicked followers dialog", { concurrency: false }, async () => {
  const trigger = new InjectedElement("a", { href: "/source/followers/", text: "20 followers" });
  const main = new InjectedElement("main").append(new InjectedElement("header").append(trigger));
  const staleDialog = new InjectedElement("div", { role: "dialog" });
  const roots = [main, staleDialog];
  const dom = installInjectedDom({ roots });
  trigger.onClick = () => roots.push(new InjectedElement("div", { role: "dialog" }));

  try {
    await assert.rejects(
      openProfileListModal(
        injectedExecutor,
        42,
        "followers",
        "https://www.instagram.com/source/",
      ),
      /pre-existing|already open/i,
    );
    assert.equal(trigger.clicks, 0);
  } finally {
    dom.restore();
  }
});

test("refuses ambiguous newly opened followers dialogs", { concurrency: false }, async () => {
  const trigger = new InjectedElement("a", { href: "/source/followers/", text: "20 followers" });
  const roots = [new InjectedElement("main").append(new InjectedElement("header").append(trigger))];
  const dom = installInjectedDom({ roots });
  trigger.onClick = () => {
    dom.location.pathname = "/source/followers/";
    roots.push(
      new InjectedElement("div", { role: "dialog" }),
      new InjectedElement("div", { role: "dialog" }),
    );
  };

  try {
    await assert.rejects(
      openProfileListModal(
        injectedExecutor,
        43,
        "followers",
        "https://www.instagram.com/source/",
      ),
      /ambiguous|multiple/i,
    );
  } finally {
    dom.restore();
  }
});

test("passes the canonical source identity and bound dialog token through every DOM step", async () => {
  const calls = [];
  const responses = [
    [{ result: { ok: true, dialogToken: "followers-bound-dialog" } }],
    [{ result: { expanded: false, reason: "expand-trigger-not-found" } }],
    [{ result: {
      items: [],
      debug: {
        scannedCount: 0,
        idlePasses: 0,
        ownerOnlyListNotice: false,
        othersSummaryText: "",
      },
    } }],
  ];
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => ({ id: 44 }),
    executeScript: async (details) => {
      calls.push(details.args || []);
      return responses.shift();
    },
    closeTab: async () => {},
    log: () => {},
  });

  await adapter.collectFollowers({ profileUrl: "@Source", limit: 25 });

  assert.deepEqual(calls, [
    ["followers", "https://www.instagram.com/source/"],
    ["https://www.instagram.com/source/", "followers-bound-dialog"],
    ["followers", 25, "https://www.instagram.com/source/", "followers-bound-dialog"],
  ]);
});

test("rejects reserved or malformed source identities before opening Instagram", async () => {
  let opened = 0;
  const adapter = createInstagramFollowers({
    openTabAndWait: async () => {
      opened += 1;
      return { id: 47 };
    },
    executeScript: async () => [],
    closeTab: async () => {},
    log: () => {},
  });

  for (const profileUrl of ["@bad-name", "https://www.instagram.com/legal/", "http://instagram.com/alice/"]) {
    await assert.rejects(
      adapter.collectFollowers({ profileUrl, limit: 10 }),
      /profile|instagram/i,
    );
  }
  assert.equal(opened, 0);
});

test("collects only exact legal one-segment profile links bound to follower rows", { concurrency: false }, async () => {
  const dialog = new InjectedElement("div", { role: "dialog" });
  dialog.setAttribute("data-instagram-followup-dialog", "followers-bound-dialog");
  dialog.append(
    followerRow("/alice/", "alice", "Alice A."),
    followerRow("/bob/followers/", "bob", "Nested route"),
    followerRow("https://example.com/mallory/", "mallory", "External host"),
    followerRow("/bad-name/", "bad-name", "Illegal handle"),
    followerRow("/legal/", "legal", "Reserved internal route"),
    new InjectedElement("div").append(
      new InjectedElement("div").append(new InjectedElement("a", { href: "/charlie/", text: "Loose link" })),
      new InjectedElement("button", { text: "Follow" }),
    ),
  );
  const roots = [dialog];
  const dom = installInjectedDom({ pathname: "/source/followers/", roots });

  try {
    const payload = await collectProfileListFromDom(
      injectedExecutor,
      45,
      "followers",
      10,
      () => {},
      "https://www.instagram.com/source/",
      "followers-bound-dialog",
    );

    assert.deepEqual(payload.items.map(({ username }) => username), ["alice"]);
  } finally {
    dom.restore();
  }
});

test("throws an executeScript InjectionResult error instead of returning an empty collection", async () => {
  await assert.rejects(
    collectProfileListFromDom(
      async () => [{ error: { message: "Cannot access the Instagram page" } }],
      46,
      "followers",
      10,
      () => {},
      "https://www.instagram.com/source/",
      "followers-bound-dialog",
    ),
    /Cannot access the Instagram page/,
  );
});

test("follows a visible Followers row only after its same-row label changes", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", displayName: "Alice A.", label: "Suivre", afterClickLabel: "Suivi(e)" },
  ]);
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    const result = await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.equal(result.processedCount, 1);
    assert.deepEqual(outcomes.map(({ handle, displayName, status, reason }) => ({
      handle,
      displayName,
      status,
      reason,
    })), [{
      handle: "alice",
      displayName: "Alice A.",
      status: "succeeded",
      reason: null,
    }]);
    assert.match(outcomes[0].profileUrl, /instagram\.com\/alice\/$/);
    assert.match(outcomes[0].at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    browser.restore();
  }
});

test("records the observed French private-account request label as a successful follow request", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "privatealice", label: "Suivre", afterClickLabel: "Demandé" },
  ]);
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ handle, status, reason }) => ({ handle, status, reason })), [{
      handle: "privatealice",
      status: "follow_request_sent",
      reason: null,
    }]);
  } finally {
    browser.restore();
  }
});

test("confirms a follow after Instagram replaces the clicked row control", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", label: "Follow", afterClickLabel: "Following", replaceOnClick: true },
  ]);
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });
    assert.deepEqual(outcomes.map(({ handle, status }) => ({ handle, status })), [
      { handle: "alice", status: "succeeded" },
    ]);
  } finally {
    browser.restore();
  }
});

test("follows a non-semantic visible Followers row bounded by a sibling profile row", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", label: "Follow", afterClickLabel: "Following" },
    { handle: "bob", label: "Follow", afterClickLabel: "Following" },
  ], { semanticRows: false });
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ handle, status }) => ({ handle, status })), [
      { handle: "alice", status: "succeeded" },
    ]);
  } finally {
    browser.restore();
  }
});

test("follows a single non-semantic visible Followers row through its local relationship control", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", label: "Follow", afterClickLabel: "Following" },
  ], { semanticRows: false });
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ handle, status }) => ({ handle, status })), [
      { handle: "alice", status: "succeeded" },
    ]);
  } finally {
    browser.restore();
  }
});

test("follows a visible Followers row when Instagram exposes the handle as text but not a profile link", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", displayName: "Alice A.", label: "Follow", afterClickLabel: "Following", link: false },
  ], { semanticRows: false });
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ handle, status }) => ({ handle, status })), [
      { handle: "alice", status: "succeeded" },
    ]);
  } finally {
    browser.restore();
  }
});

test("uses the leaf handle instead of a concatenated wrapper when a visible Followers row has no profile link", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", displayName: "alice", label: "Follow", afterClickLabel: "Following", link: false, wrappedHandleText: true },
  ], { semanticRows: false });
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ handle, status }) => ({ handle, status })), [
      { handle: "alice", status: "succeeded" },
    ]);
  } finally {
    browser.restore();
  }
});

test("waits for a Followers row that Instagram renders after the modal shell", { concurrency: false }, async () => {
  const browser = browserModalWithRows([], {
    delayedRows: [{ handle: "alice", label: "Follow", afterClickLabel: "Following" }],
    delayedRowsMs: 1_000,
    semanticRows: false,
  });
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ handle, status }) => ({ handle, status })), [
      { handle: "alice", status: "succeeded" },
    ]);
  } finally {
    browser.restore();
  }
});

test("does not report an empty Followers modal as a completed direct follow pass", { concurrency: false }, async () => {
  const browser = browserModalWithRows([]);
  const adapter = createInstagramFollowers(browser);

  try {
    await assert.rejects(
      adapter.collectAndFollowFollowers({ profileUrl: "@source", limit: 1 }),
      /no eligible visible follower row/i,
    );
  } finally {
    browser.restore();
  }
});

test("reports an already-followed visible Followers row as skipped without clicking it", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", label: "Suivi(e)" },
  ]);
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ status, reason }) => ({ status, reason })), [{
      status: "skipped",
      reason: "already-following",
    }]);
  } finally {
    browser.restore();
  }
});

test("does not spend the direct follow limit on an already-followed row", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "already", label: "Following" },
    { handle: "alice", label: "Follow", afterClickLabel: "Following" },
    { handle: "bob", label: "Follow", afterClickLabel: "Following" },
  ]);
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    const result = await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 2,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ handle, status }) => ({ handle, status })), [
      { handle: "already", status: "skipped" },
      { handle: "alice", status: "succeeded" },
      { handle: "bob", status: "succeeded" },
    ]);
    assert.equal(result.processedCount, 2);
  } finally {
    browser.restore();
  }
});

test("scrolls the bound Followers list to process rows beyond the first viewport", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", label: "Follow", afterClickLabel: "Following" },
  ], {
    revealOnScroll: [
      { handle: "bob", label: "Follow", afterClickLabel: "Following" },
    ],
  });
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    const result = await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 3,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.equal(result.processedCount, 2);
    assert.deepEqual(outcomes.map(({ handle }) => handle), ["alice", "bob"]);
    assert.ok(browser.scrollEvents() >= 1);
    assert.ok(browser.scrollEvents() < 10, "scrolling must stop after bounded idle passes");
  } finally {
    browser.restore();
  }
});

test("preserves owner-only and preview warnings during direct modal follows", { concurrency: false }, async () => {
  const scenarios = [
    {
      limitationText: "Only source can see all followers",
      warning: "Instagram limited this followers list. Only the account owner can see the full followers list for this profile.",
    },
    {
      limitationText: "Instagram is showing alice and 42 others",
      warning: "Instagram limited this followers list. Instagram is showing a preview list (and 42 others) instead of the full followers list.",
    },
  ];

  for (const scenario of scenarios) {
    const browser = browserModalWithRows([
      { handle: "alice", label: "Follow", afterClickLabel: "Following" },
    ], { limitationText: scenario.limitationText });
    const adapter = createInstagramFollowers(browser);

    try {
      const result = await adapter.collectAndFollowFollowers({
        profileUrl: "@source",
        limit: 1,
      });
      assert.equal(result.warning, scenario.warning);
    } finally {
      browser.restore();
    }
  }
});

test("reports an ambiguous row control as failed instead of clicking a visible Followers row", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", label: "Follow", controls: 2 },
  ]);
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ status, reason }) => ({ status, reason })), [{
      status: "failed",
      reason: "ambiguous-row-control",
    }]);
  } finally {
    browser.restore();
  }
});

test("reports a missing row control as failed for a visible Followers row", { concurrency: false }, async () => {
  const browser = browserModalWithRows([
    { handle: "alice", label: "Follow", controls: 0 },
  ]);
  const adapter = createInstagramFollowers(browser);
  const outcomes = [];

  try {
    await adapter.collectAndFollowFollowers({
      profileUrl: "@source",
      limit: 1,
      onOutcome: async (outcome) => outcomes.push(outcome),
    });

    assert.deepEqual(outcomes.map(({ status, reason }) => ({ status, reason })), [{
      status: "failed",
      reason: "missing-row-control",
    }]);
  } finally {
    browser.restore();
  }
});

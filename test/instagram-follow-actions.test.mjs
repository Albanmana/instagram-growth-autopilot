import { test } from "node:test";
import assert from "node:assert/strict";
import { performInstagramRelationshipAction } from "../extension/instagram-follow-actions.js";

class FakeElement {
  constructor(tagName, {
    text = "",
    href = "",
    role = "",
    visible = true,
    hidden = false,
    display = "block",
    visibility = "visible",
    rect,
  } = {}) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.parentElement = null;
    this.children = [];
    this.visible = visible;
    this.hidden = hidden;
    this.computedStyle = { display, visibility };
    this.rect = rect || { top: 0, left: 0, width: 100, height: 24 };
    this.isConnected = true;
    this.attributes = new Map();
    if (href) this.attributes.set("href", href);
    if (role) this.attributes.set("role", role);
    this.clicks = 0;
    this.onClick = null;
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

  getBoundingClientRect() {
    return this.visible && this.isConnected
      ? this.rect
      : { ...this.rect, width: 0, height: 0 };
  }

  querySelectorAll(selector) {
    return descendants(this).filter((element) => matchesSelector(element, selector));
  }

  click() {
    this.clicks += 1;
    this.onClick?.();
  }
}

function descendants(root) {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function disconnectTree(root) {
  root.isConnected = false;
  for (const child of root.children) disconnectTree(child);
}

function connectTree(root) {
  root.isConnected = true;
  for (const child of root.children) connectTree(child);
}

function matchesSelector(element, selector) {
  return selector.split(",").some((part) => {
    const value = part.trim();
    if (value === "header") return element.tagName === "HEADER";
    if (value === "main") return element.tagName === "MAIN";
    if (value === "*") return true;
    if (value === "button") return element.tagName === "BUTTON";
    if (value === "[role='button']") return element.getAttribute("role") === "button";
    if (value === "a[href]") return element.tagName === "A" && element.getAttribute("href") != null;
    if (value === "div[role='dialog']") return element.tagName === "DIV" && element.getAttribute("role") === "dialog";
    if (value === "section[role='dialog']") return element.tagName === "SECTION" && element.getAttribute("role") === "dialog";
    return false;
  });
}

function installDom({ pathname, roots }) {
  const original = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    location: globalThis.location,
    getComputedStyle: globalThis.getComputedStyle,
    setTimeout: globalThis.setTimeout,
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.location = { pathname };
  globalThis.getComputedStyle = (element) => element.computedStyle;
  const allElements = () => roots.flatMap((root) => [root, ...descendants(root)]);
  const body = new FakeElement("body");
  body.querySelectorAll = (selector) => allElements().filter((element) => matchesSelector(element, selector));
  globalThis.document = {
    body,
    querySelectorAll(selector) {
      return allElements().filter((element) => matchesSelector(element, selector));
    },
  };
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 1;
  };
  return () => Object.assign(globalThis, original);
}

function relationshipButton(label) {
  return new FakeElement("button", { text: label });
}

function relationshipButtonWithDecoration(label) {
  return new FakeElement("button").append(new FakeElement("div").append(
    new FakeElement("span", { text: label }),
    new FakeElement("span", { text: "Icon chevron" }),
  ));
}

function installProfileDom({
  pathname = "/alice/",
  initialLabel = "Follow",
  profileContainerTag = "header",
  includeMain = true,
  afterClickLabel,
  afterClickSiblingLabel,
  confirmationLabel,
  afterConfirmationLabel,
  unrelatedLabel,
}) {
  const main = new FakeElement("main");
  const header = new FakeElement(profileContainerTag);
  const button = relationshipButton(initialLabel);
  header.append(button);
  if (includeMain) main.append(header);
  const roots = [includeMain ? main : header];

  let confirmation = null;
  if (unrelatedLabel) {
    roots.push(new FakeElement("nav").append(relationshipButton(unrelatedLabel)));
  }

  button.onClick = () => {
    if (afterClickLabel) button.textContent = afterClickLabel;
    if (afterClickSiblingLabel) header.append(relationshipButton(afterClickSiblingLabel));
    if (confirmationLabel) {
      const dialog = new FakeElement("div", { role: "dialog" });
      confirmation = relationshipButton(confirmationLabel);
      confirmation.onClick = () => {
        if (afterConfirmationLabel) button.textContent = afterConfirmationLabel;
      };
      dialog.append(confirmation);
      roots.push(dialog);
    }
  };

  return {
    button,
    get confirmation() {
      return confirmation;
    },
    restore: installDom({ pathname, roots }),
  };
}

function buildFollowingRow(handle, label, { nesting = 2 } = {}) {
  const row = new FakeElement("div");
  let container = row;
  for (let index = 0; index < nesting; index += 1) {
    const wrapper = new FakeElement("div");
    container.append(wrapper);
    container = wrapper;
  }
  const anchor = new FakeElement("a", { href: `/${handle}/`, text: handle });
  const button = relationshipButton(label);
  container.append(anchor);
  row.append(button);
  return { row, anchor, button };
}

function buildFollowingRowWithDuplicateHandleAnchors(handle, label) {
  const row = new FakeElement("div");
  const avatarAnchor = new FakeElement("a", { href: `/${handle}/`, text: "avatar" });
  const usernameAnchor = new FakeElement("a", { href: `/${handle}/`, text: handle });
  const button = relationshipButton(label);
  row.append(
    new FakeElement("div").append(avatarAnchor),
    new FakeElement("div").append(usernameAnchor),
    button,
  );
  return { row, avatarAnchor, usernameAnchor, button };
}

function installFollowingListDom({
  pathname = "/source/following/",
  targetHandle = "alice",
  targetLabel = "Following",
  targetNesting = 2,
  confirmationLabel = "Unfollow",
  afterConfirmationLabel = "Follow",
  removeAfterConfirmation = false,
  maskListDuringConfirmation = false,
}) {
  const dialog = new FakeElement("div", { role: "dialog" });
  const unrelated = buildFollowingRow("bob", "Following");
  const target = buildFollowingRow(targetHandle, targetLabel, { nesting: targetNesting });
  dialog.append(unrelated.row, target.row);
  const roots = [dialog];
  let confirmation = null;

  target.button.onClick = () => {
    if (!confirmationLabel) return;
    if (maskListDuringConfirmation) dialog.hidden = true;
    const confirmationDialog = new FakeElement("div", { role: "dialog" });
    confirmation = relationshipButton(confirmationLabel);
    confirmation.onClick = () => {
      if (removeAfterConfirmation) {
        dialog.children = dialog.children.filter((child) => child !== target.row);
        target.row.parentElement = null;
        disconnectTree(target.row);
      } else if (afterConfirmationLabel) {
        target.button.textContent = afterConfirmationLabel;
      }
    };
    confirmationDialog.append(confirmation);
    roots.push(confirmationDialog);
  };

  return {
    dialog,
    target,
    unrelated,
    get confirmation() {
      return confirmation;
    },
    restore: installDom({ pathname, roots }),
  };
}

test("follows only when the loaded canonical profile matches and the visible header button changes to Following", { concurrency: false }, async () => {
  const dom = installProfileDom({ initialLabel: "Follow", afterClickLabel: "Following", unrelatedLabel: "Follow" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "succeeded");
    assert.equal(dom.button.clicks, 1);
    assert.match(result.at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    dom.restore();
  }
});

test("accepts the observed French follow labels", { concurrency: false }, async () => {
  const dom = installProfileDom({ initialLabel: "Suivre", afterClickLabel: "Suivi(e)" });
  try {
    assert.equal((await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" })).status, "succeeded");
  } finally {
    dom.restore();
  }
});

test("records a private-account follow request as a successful requested outcome", { concurrency: false }, async () => {
  const dom = installProfileDom({ initialLabel: "Suivre", afterClickLabel: "Demandé" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "follow_request_sent");
    assert.equal(dom.button.clicks, 1);
  } finally {
    dom.restore();
  }
});

test("cancels an unaccepted private follow request from the canonical profile", { concurrency: false }, async () => {
  const dom = installProfileDom({
    initialLabel: "Demandé",
    confirmationLabel: "Ne plus suivre",
    afterConfirmationLabel: "Suivre",
  });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(dom.button.clicks, 1);
    assert.equal(dom.confirmation.clicks, 1);
  } finally {
    dom.restore();
  }
});

test("cancels an unaccepted private request from the sole visible profile-main control", { concurrency: false }, async () => {
  const dom = installProfileDom({
    initialLabel: "Demandé",
    profileContainerTag: "div",
    confirmationLabel: "Ne plus suivre",
    afterConfirmationLabel: "Suivre",
  });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(dom.button.clicks, 1);
    assert.equal(dom.confirmation.clicks, 1);
  } finally {
    dom.restore();
  }
});

test("does not click an unrelated profile or report success without final state", { concurrency: false }, async () => {
  const mismatched = installProfileDom({ pathname: "/bob/", initialLabel: "Follow", afterClickLabel: "Following" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "skipped");
    assert.equal(mismatched.button.clicks, 0);
  } finally {
    mismatched.restore();
  }

  const unchanged = installProfileDom({ initialLabel: "Follow" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "failed");
    assert.equal(unchanged.button.clicks, 1);
  } finally {
    unchanged.restore();
  }
});

test("does not confirm follow from a different relationship button appearing in the same header", { concurrency: false }, async () => {
  const dom = installProfileDom({ initialLabel: "Follow", afterClickSiblingLabel: "Following" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "failed");
    assert.equal(dom.button.clicks, 1);
  } finally {
    dom.restore();
  }
});

test("ignores relationship controls in navigation and drawer headers", { concurrency: false }, async () => {
  const drawerHeader = new FakeElement("header").append(relationshipButton("Follow"));
  const navigation = new FakeElement("nav").append(drawerHeader);
  const main = new FakeElement("main").append(new FakeElement("header"));
  const restore = installDom({ pathname: "/alice/", roots: [navigation, main] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "failed");
    assert.equal(drawerHeader.children[0].clicks, 0);
  } finally {
    restore();
  }
});

test("ignores navigation relationship controls nested inside the profile header", { concurrency: false }, async () => {
  const nestedControl = relationshipButton("Follow");
  const header = new FakeElement("header").append(new FakeElement("nav").append(nestedControl));
  const main = new FakeElement("main").append(header);
  const restore = installDom({ pathname: "/alice/", roots: [main] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "failed");
    assert.equal(nestedControl.clicks, 0);
  } finally {
    restore();
  }
});

test("requires an exact canonical profile pathname", { concurrency: false }, async () => {
  for (const pathname of ["/alice/followers/", "/p/alice/", "/alice/extra/"]) {
    const dom = installProfileDom({ pathname, initialLabel: "Follow", afterClickLabel: "Following" });
    try {
      const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
      assert.equal(result.status, "skipped");
      assert.equal(dom.button.clicks, 0);
    } finally {
      dom.restore();
    }
  }
});

test("skips a profile that is already in the requested relationship state", { concurrency: false }, async () => {
  for (const [action, label] of [["follow", "Following"], ["unfollow", "Follow"]]) {
    const dom = installProfileDom({ initialLabel: label });
    try {
      const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action });
      assert.equal(result.status, "skipped");
      assert.equal(dom.button.clicks, 0);
    } finally {
      dom.restore();
    }
  }
});

test("tags an already-desired state with only the exact persisted intent context", { concurrency: false }, async () => {
  const intent = {
    intentId: "follow:instagram:alice:2026-08-13T00:59:59.000Z",
    candidateId: "instagram:alice",
    expectedHandle: "alice",
    action: "follow",
    recoveringPersistedIntent: true,
  };
  const dom = installProfileDom({ initialLabel: "Following" });
  try {
    const result = await performInstagramRelationshipAction({
      expectedHandle: "alice",
      action: "follow",
      actionContext: intent,
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "already_desired");
    assert.equal(result.intentId, intent.intentId);
    assert.equal(dom.button.clicks, 0);
  } finally {
    dom.restore();
  }

  const mismatched = installProfileDom({ initialLabel: "Following" });
  try {
    const result = await performInstagramRelationshipAction({
      expectedHandle: "alice",
      action: "follow",
      actionContext: { ...intent, candidateId: "instagram:bob" },
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "already_desired");
    assert.equal(result.intentId, undefined);
    assert.equal(mismatched.button.clicks, 0);
  } finally {
    mismatched.restore();
  }
});

test("unfollows a matching profile only after exact confirmation and visible final state", { concurrency: false }, async () => {
  const dom = installProfileDom({
    initialLabel: "Following",
    confirmationLabel: "Unfollow",
    afterConfirmationLabel: "Follow",
  });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(dom.button.clicks, 1);
    assert.equal(dom.confirmation.clicks, 1);
  } finally {
    dom.restore();
  }
});

test("reports bounded visible-profile control diagnostics when the unfollow control is absent", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  main.append(
    new FakeElement("button", { text: "Message", rect: { top: 100, left: 800, width: 120, height: 36 } }),
    new FakeElement("button", { text: "More", rect: { top: 100, left: 940, width: 48, height: 36 } }),
  );
  const restore = installDom({ pathname: "/alice/", roots: [main] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.match(result.reason, /Visible profile controls:.*message.*more/i);
  } finally {
    restore();
  }
});

test("accepts an unambiguous replacement Follow control only after the exact unfollow confirmation", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  const header = new FakeElement("header");
  const following = relationshipButton("Following");
  header.append(following);
  main.append(header);
  const roots = [main];
  following.onClick = () => {
    const dialog = new FakeElement("div", { role: "dialog" });
    const confirmation = relationshipButton("Unfollow");
    confirmation.onClick = () => {
      following.visible = false;
      following.isConnected = false;
      header.append(relationshipButton("Follow"));
    };
    dialog.append(confirmation);
    roots.push(dialog);
  };
  const restore = installDom({ pathname: "/alice/", roots });
  try {
    assert.equal((await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" })).status, "succeeded");
  } finally {
    restore();
  }
});

test("confirms an unfollow from the target profile when suggestions also expose Follow controls", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  const profile = new FakeElement("div");
  const following = new FakeElement("button", { text: "Following", rect: { top: 100, left: 800, width: 120, height: 36 } });
  profile.append(following);
  const suggestions = new FakeElement("div").append(
    new FakeElement("a", { href: "/bob/", text: "bob" }),
    new FakeElement("button", { text: "Follow", rect: { top: 500, left: 800, width: 120, height: 36 } }),
    new FakeElement("a", { href: "/carol/", text: "carol" }),
    new FakeElement("button", { text: "Follow", rect: { top: 580, left: 800, width: 120, height: 36 } }),
  );
  main.append(profile, suggestions);
  const roots = [main];
  following.onClick = () => {
    const dialog = new FakeElement("div", { role: "dialog" });
    const confirmation = relationshipButton("Unfollow");
    confirmation.onClick = () => {
      following.visible = false;
      following.isConnected = false;
      profile.append(new FakeElement("button", { text: "Follow", rect: { top: 100, left: 800, width: 120, height: 36 } }));
    };
    dialog.append(confirmation);
    roots.push(dialog);
  };
  const restore = installDom({ pathname: "/alice/", roots });
  try {
    assert.equal((await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" })).status, "succeeded");
    assert.equal(following.clicks, 1);
  } finally {
    restore();
  }
});

test("recognizes the top profile Follow control before lower suggestion controls as already unfollowed", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  const profileFollow = new FakeElement("button", { text: "Follow", rect: { top: 100, left: 800, width: 120, height: 36 } });
  main.append(
    new FakeElement("div").append(profileFollow),
    new FakeElement("div").append(
      new FakeElement("a", { href: "/bob/", text: "bob" }),
      new FakeElement("button", { text: "Follow", rect: { top: 500, left: 800, width: 120, height: 36 } }),
      new FakeElement("a", { href: "/carol/", text: "carol" }),
      new FakeElement("button", { text: "Follow", rect: { top: 580, left: 800, width: 120, height: 36 } }),
    ),
  );
  const restore = installDom({ pathname: "/alice/", roots: [main] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "already_desired");
    assert.equal(profileFollow.clicks, 0);
  } finally {
    restore();
  }
});

test("recognizes the observed French Follow Back profile control as already unfollowed", { concurrency: false }, async () => {
  const page = installProfileDom({ initialLabel: "Suivre en retour" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "skipped");
    assert.equal(result.code, "already_desired");
    assert.equal(page.button.clicks, 0);
  } finally {
    page.restore();
  }
});

test("recognizes the direct relationship label when Instagram appends decorative button text", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  const header = new FakeElement("header");
  const following = relationshipButtonWithDecoration("Suivi(e)");
  header.append(following);
  main.append(header);
  const roots = [main];
  following.onClick = () => {
    const dialog = new FakeElement("div", { role: "dialog" });
    const confirm = relationshipButton("Ne plus suivre");
    confirm.onClick = () => {
      following.children[0].children[0].textContent = "Suivre";
    };
    dialog.append(confirm);
    roots.push(dialog);
  };
  const restore = installDom({ pathname: "/alice/", roots });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(following.clicks, 1);
  } finally {
    restore();
  }
});

test("unfollows the sole visible relationship control in the canonical profile main when Instagram omits a header", { concurrency: false }, async () => {
  const page = installProfileDom({
    initialLabel: "Suivi(e)",
    profileContainerTag: "div",
    confirmationLabel: "Ne plus suivre",
    afterConfirmationLabel: "Suivre",
  });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });

    assert.equal(result.status, "succeeded");
    assert.equal(page.button.clicks, 1);
    assert.equal(page.confirmation?.clicks, 1);
  } finally {
    page.restore();
  }
});

test("unfollows the sole visible relationship control on an exact profile route when Instagram omits semantic profile containers", { concurrency: false }, async () => {
  const page = installProfileDom({
    initialLabel: "Suivi(e)",
    profileContainerTag: "div",
    includeMain: false,
    confirmationLabel: "Ne plus suivre",
    afterConfirmationLabel: "Suivre",
  });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });

    assert.equal(result.status, "succeeded");
    assert.equal(page.button.clicks, 1);
  } finally {
    page.restore();
  }
});

test("waits for a delayed profile relationship control before unfollowing", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  const header = new FakeElement("header");
  const following = relationshipButton("Following");
  header.append(following);
  const roots = [main];
  let confirmation = null;
  following.onClick = () => {
    const dialog = new FakeElement("div", { role: "dialog" });
    confirmation = relationshipButton("Unfollow");
    confirmation.onClick = () => { following.textContent = "Follow"; };
    dialog.append(confirmation);
    roots.push(dialog);
  };
  const restore = installDom({ pathname: "/alice/", roots });
  const fakeTimer = globalThis.setTimeout;
  let rendered = false;
  globalThis.setTimeout = (callback) => {
    if (!rendered) {
      rendered = true;
      main.append(header);
    }
    return fakeTimer(callback);
  };
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(rendered, true);
    assert.equal(following.clicks, 1);
    assert.equal(confirmation.clicks, 1);
  } finally {
    restore();
  }
});

test("clicks only the new topmost confirmation dialog created by the profile action", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  const header = new FakeElement("header");
  const following = relationshipButton("Following");
  header.append(following);
  main.append(header);

  const staleDialog = new FakeElement("div", { role: "dialog" });
  const staleConfirmation = relationshipButton("Unfollow");
  staleDialog.append(staleConfirmation);
  const roots = [main, staleDialog];

  let actionConfirmation = null;
  following.onClick = () => {
    const actionDialog = new FakeElement("div", { role: "dialog" });
    actionConfirmation = relationshipButton("Unfollow");
    actionConfirmation.onClick = () => {
      following.textContent = "Follow";
    };
    actionDialog.append(actionConfirmation);
    roots.push(actionDialog);
  };

  const restore = installDom({ pathname: "/alice/", roots });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(staleConfirmation.clicks, 0);
    assert.equal(actionConfirmation.clicks, 1);
  } finally {
    restore();
  }
});

test("uses the observed French unfollow confirmation", { concurrency: false }, async () => {
  const dom = installProfileDom({
    initialLabel: "Suivi(e)",
    confirmationLabel: "Ne plus suivre",
    afterConfirmationLabel: "Suivre",
  });
  try {
    assert.equal((await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" })).status, "succeeded");
  } finally {
    dom.restore();
  }
});

test("unfollows only the Following-list row located from the target canonical link", { concurrency: false }, async () => {
  const dom = installFollowingListDom({});
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(dom.target.button.clicks, 1);
    assert.equal(dom.unrelated.button.clicks, 0);
    assert.equal(dom.confirmation.clicks, 1);
  } finally {
    dom.restore();
  }
});

test("ignores duplicate canonical anchors for the target handle when finding the next profile-row boundary", { concurrency: false }, async () => {
  const dialog = new FakeElement("div", { role: "dialog" });
  const unrelated = buildFollowingRow("bob", "Following");
  const target = buildFollowingRowWithDuplicateHandleAnchors("alice", "Following");
  dialog.append(unrelated.row, target.row);
  const roots = [dialog];
  let confirmation = null;

  target.button.onClick = () => {
    const confirmationDialog = new FakeElement("div", { role: "dialog" });
    confirmation = relationshipButton("Unfollow");
    confirmation.onClick = () => {
      target.button.textContent = "Follow";
    };
    confirmationDialog.append(confirmation);
    roots.push(confirmationDialog);
  };

  const restore = installDom({ pathname: "/source/following/", roots });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(target.button.clicks, 1);
    assert.equal(unrelated.button.clicks, 0);
    assert.equal(confirmation.clicks, 1);
  } finally {
    restore();
  }
});

test("does not use Following-list row controls outside an exact Following route", { concurrency: false }, async () => {
  const dom = installFollowingListDom({ pathname: "/explore/" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "skipped");
    assert.equal(dom.target.button.clicks, 0);
    assert.equal(dom.unrelated.button.clicks, 0);
  } finally {
    dom.restore();
  }
});

test("does not select another row button when the target Following-list row has none", { concurrency: false }, async () => {
  const dialog = new FakeElement("div", { role: "dialog" });
  const targetRow = new FakeElement("div").append(new FakeElement("a", { href: "/alice/", text: "alice" }));
  const unrelated = buildFollowingRow("bob", "Following");
  dialog.append(targetRow, unrelated.row);
  const restore = installDom({ pathname: "/source/following/", roots: [dialog] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(unrelated.button.clicks, 0);
  } finally {
    restore();
  }
});

test("stops Following-list row lookup before the dialog-wide relationship control", { concurrency: false }, async () => {
  const dialog = new FakeElement("div", { role: "dialog" });
  const targetRow = new FakeElement("div").append(new FakeElement("a", { href: "/alice/", text: "alice" }));
  const dialogWideControl = relationshipButton("Following");
  dialog.append(targetRow, dialogWideControl);
  const restore = installDom({ pathname: "/source/following/", roots: [dialog] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(dialogWideControl.clicks, 0);
  } finally {
    restore();
  }
});

test("does not widen a target link without a row control into a one-link dialog-content wrapper", { concurrency: false }, async () => {
  const dialog = new FakeElement("div", { role: "dialog" });
  const dialogContent = new FakeElement("div");
  const targetWithoutControl = new FakeElement("div").append(
    new FakeElement("a", { href: "/alice/", text: "alice" }),
  );
  const unrelatedFollowing = relationshipButton("Following");
  dialogContent.append(targetWithoutControl, unrelatedFollowing);
  dialog.append(dialogContent);
  const restore = installDom({ pathname: "/source/following/", roots: [dialog] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(unrelatedFollowing.clicks, 0);
  } finally {
    restore();
  }
});

test("accepts a Following-list row disappearing as visible unfollow confirmation", { concurrency: false }, async () => {
  const dom = installFollowingListDom({ removeAfterConfirmation: true });
  try {
    assert.equal((await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" })).status, "succeeded");
  } finally {
    dom.restore();
  }
});

test("waits through a confirmation mask for the re-exposed Following-list control to change", { concurrency: false }, async () => {
  const dom = installFollowingListDom({ maskListDuringConfirmation: true });
  const fakeTimer = globalThis.setTimeout;
  let revealed = false;
  globalThis.setTimeout = (callback) => {
    if (!revealed && dom.confirmation?.clicks === 1) {
      revealed = true;
      dom.dialog.hidden = false;
    }
    return fakeTimer(callback);
  };
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "succeeded");
    assert.equal(revealed, true);
    assert.equal(dom.target.button.textContent, "Follow");
  } finally {
    dom.restore();
  }
});

test("does not treat a temporarily masked unchanged Following-list row as unfollow proof", { concurrency: false }, async () => {
  const dom = installFollowingListDom({
    afterConfirmationLabel: "Following",
    maskListDuringConfirmation: true,
  });
  const fakeTimer = globalThis.setTimeout;
  let revealed = false;
  globalThis.setTimeout = (callback) => {
    if (!revealed && dom.confirmation?.clicks === 1) {
      revealed = true;
      dom.dialog.hidden = false;
    }
    return fakeTimer(callback);
  };
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(revealed, true);
    assert.equal(dom.target.button.textContent, "Following");
  } finally {
    dom.restore();
  }
});

test("does not treat a persistently masked target row as stable absence", { concurrency: false }, async () => {
  const dom = installFollowingListDom({
    afterConfirmationLabel: "Following",
    maskListDuringConfirmation: true,
  });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(dom.target.button.textContent, "Following");
    assert.equal(dom.dialog.hidden, true);
  } finally {
    dom.restore();
  }
});

test("does not report success when a target row reconnects after the former absence threshold", { concurrency: false }, async () => {
  const dom = installFollowingListDom({ afterConfirmationLabel: "Following" });
  dom.target.button.onClick = () => {
    const confirmationDialog = new FakeElement("div", { role: "dialog" });
    const confirmation = relationshipButton("Unfollow");
    confirmation.onClick = () => {
      dom.dialog.children = dom.dialog.children.filter((child) => child !== dom.target.row);
      dom.target.row.parentElement = null;
      disconnectTree(dom.target.row);
    };
    confirmationDialog.append(confirmation);
    dom.dialog.append(confirmationDialog);
  };

  const fakeTimer = globalThis.setTimeout;
  const reconnectAfterWaits = 5;
  let waitCalls = 0;
  let reconnected = false;
  globalThis.setTimeout = (callback) => {
    waitCalls += 1;
    if (!reconnected && waitCalls === reconnectAfterWaits) {
      reconnected = true;
      connectTree(dom.target.row);
      dom.dialog.append(dom.target.row);
      dom.target.button.textContent = "Following";
    }
    return fakeTimer(callback);
  };

  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(reconnected, true);
    assert.equal(dom.target.button.textContent, "Following");
    assert.ok(waitCalls > reconnectAfterWaits);
  } finally {
    dom.restore();
  }
});

test("rechecks the target row after the fortieth wait before accepting absence", { concurrency: false }, async () => {
  const dom = installFollowingListDom({ afterConfirmationLabel: "Following" });
  dom.target.button.onClick = () => {
    const confirmationDialog = new FakeElement("div", { role: "dialog" });
    const confirmation = relationshipButton("Unfollow");
    confirmation.onClick = () => {
      dom.dialog.children = dom.dialog.children.filter((child) => child !== dom.target.row);
      dom.target.row.parentElement = null;
      disconnectTree(dom.target.row);
    };
    confirmationDialog.append(confirmation);
    dom.dialog.append(confirmationDialog);
  };

  const fakeTimer = globalThis.setTimeout;
  let waitCalls = 0;
  globalThis.setTimeout = (callback) => {
    waitCalls += 1;
    if (waitCalls === 40) {
      connectTree(dom.target.row);
      dom.dialog.append(dom.target.row);
      dom.target.button.textContent = "Following";
    }
    return fakeTimer(callback);
  };

  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(waitCalls, 40);
    assert.equal(dom.target.button.textContent, "Following");
  } finally {
    dom.restore();
  }
});

test("does not treat a temporary target-row disconnect before reconnecting as Following as unfollow proof", { concurrency: false }, async () => {
  const dom = installFollowingListDom({ afterConfirmationLabel: "Following" });
  dom.target.button.onClick = () => {
    const confirmationDialog = new FakeElement("div", { role: "dialog" });
    const confirmation = relationshipButton("Unfollow");
    confirmation.onClick = () => {
      dom.dialog.children = dom.dialog.children.filter((child) => child !== dom.target.row);
      dom.target.row.parentElement = null;
      disconnectTree(dom.target.row);
    };
    confirmationDialog.append(confirmation);
    dom.dialog.append(confirmationDialog);
  };

  const fakeTimer = globalThis.setTimeout;
  let reconnected = false;
  globalThis.setTimeout = (callback) => {
    if (!reconnected && dom.target.row.isConnected === false) {
      reconnected = true;
      connectTree(dom.target.row);
      dom.dialog.append(dom.target.row);
      dom.target.button.textContent = "Following";
    }
    return fakeTimer(callback);
  };

  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(reconnected, true);
    assert.equal(dom.target.button.textContent, "Following");
  } finally {
    dom.restore();
  }
});

test("does not use a relationship button beyond eight ancestors from the canonical link", { concurrency: false }, async () => {
  const dom = installFollowingListDom({ targetNesting: 9 });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(dom.target.button.clicks, 0);
    assert.equal(dom.unrelated.button.clicks, 0);
  } finally {
    dom.restore();
  }
});

test("fails when Following-list confirmation or final row state is not observed", { concurrency: false }, async () => {
  const missingConfirmation = installFollowingListDom({ confirmationLabel: "Cancel" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(missingConfirmation.target.button.clicks, 1);
    assert.equal(missingConfirmation.confirmation.clicks, 0);
  } finally {
    missingConfirmation.restore();
  }

  const unchanged = installFollowingListDom({ afterConfirmationLabel: "Following" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "failed");
    assert.equal(unchanged.confirmation.clicks, 1);
  } finally {
    unchanged.restore();
  }
});

test("rejects unsupported actions without clicking", { concurrency: false }, async () => {
  const dom = installProfileDom({ initialLabel: "Follow", afterClickLabel: "Following" });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "block" });
    assert.equal(result.status, "failed");
    assert.equal(dom.button.clicks, 0);
  } finally {
    dom.restore();
  }
});

test("rejects relationship controls hidden by an HTML or CSS-hidden ancestor", { concurrency: false }, async () => {
  for (const hiddenAncestor of [
    new FakeElement("div", { hidden: true }),
    new FakeElement("div", { display: "none" }),
  ]) {
    const button = relationshipButton("Follow");
    button.onClick = () => {
      button.textContent = "Following";
    };
    const main = new FakeElement("main").append(
      new FakeElement("header").append(hiddenAncestor.append(button)),
    );
    const restore = installDom({ pathname: "/alice/", roots: [main] });
    try {
      const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
      assert.equal(result.status, "failed");
      assert.equal(button.clicks, 0);
    } finally {
      restore();
    }
  }
});

test("does not accept an unrelated replacement for the clicked profile control", { concurrency: false }, async () => {
  const main = new FakeElement("main");
  const header = new FakeElement("header");
  const button = relationshipButton("Follow");
  header.append(button);
  main.append(header);
  button.onClick = () => {
    button.visible = false;
    button.isConnected = false;
    header.append(relationshipButton("Following"));
  };
  const restore = installDom({ pathname: "/alice/", roots: [main] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "failed");
    assert.equal(button.clicks, 1);
  } finally {
    restore();
  }
});

test("does not accept a profile state change after SPA navigation leaves the original route", { concurrency: false }, async () => {
  const dom = installProfileDom({ initialLabel: "Follow" });
  dom.button.onClick = () => {
    dom.button.textContent = "Following";
    globalThis.location.pathname = "/bob/";
  };
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "follow" });
    assert.equal(result.status, "failed");
    assert.equal(dom.button.clicks, 1);
  } finally {
    dom.restore();
  }
});

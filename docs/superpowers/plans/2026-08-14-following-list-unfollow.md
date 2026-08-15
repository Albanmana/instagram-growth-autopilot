# Following-List Unfollow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute an unfollow only from the exact target row in the authenticated account's Instagram Following list.

**Architecture:** Keep direct target-profile navigation for follows. For unfollows, use the authenticated Instagram handle stored with a new pairing, or retrieve that handle from the loopback service for an existing pairing, then open `/<own-handle>/following/` and inject the existing row-scoped relationship action. The injected action already verifies the canonical target link, relationship control, confirmation dialog, and post-action row state; an unavailable list must produce no action.

**Tech Stack:** Manifest V3 service worker, Chrome tabs/scripting APIs, native ESM tests with `node --test`.

## Global Constraints

- Reload the unpacked extension with `reload-unpacked-chrome-extension` before every live test after an extension-file change.
- Use a fresh Computer Use accessibility tree before each UI action.
- Never fall back from a missing Following-list row to an unscoped profile control.
- Test live unfollows two at a time only; stop the autopilot after the pair.

---

### Task 1: Route unfollows to the authenticated Following list

**Files:**
- Modify: `extension/background.js:156-193, 224-255, 346-360`, `extension/followup-service-client.js:35-53`, `local-service/{domain,repository,server}.mjs`
- Test: `test/background-followup.test.mjs:388-445`

**Interfaces:**
- Consumes: `connection.normalizedHandle`, returned by `pairLocalService()` from `account.normalizedHandle`, or `GET /v1/account` for an existing pairing.
- Produces: `createInstagramRelationshipGateway({ ownHandle })`, whose action function opens `https://www.instagram.com/<ownHandle>/following/` only when `action === "unfollow"`.

- [ ] **Step 1: Write the failing gateway test**

```js
test("relationship gateway opens the authenticated Following list for an unfollow", async () => {
  const opened = [];
  const gateway = createInstagramRelationshipGateway({
    ownHandle: "alban.automation",
    async openTabAndWait(url) { opened.push(url); return { id: 7 }; },
    async waitForProfile() {},
    async executeScript() { return [{ result: { status: "succeeded" } }]; },
    async closeTab() {},
  });

  await gateway({ expectedHandle: "alice", action: "unfollow" });
  assert.deepEqual(opened, ["https://www.instagram.com/alban.automation/following/"]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test test/background-followup.test.mjs --test-name-pattern="authenticated Following list"`

Expected: FAIL because the gateway currently opens `https://www.instagram.com/alice/`.

- [ ] **Step 3: Implement the minimal route selection**

```js
const ownProfileUrl = ownHandle ? normalizeSourceInput(ownHandle) : null;
const actionUrl = action === "unfollow" && ownProfileUrl
  ? new URL("following/", ownProfileUrl).href
  : normalizeSourceInput(expectedHandle);
tab = await openTabAndWait(actionUrl, true, { waitForComplete: true });
```

Reject an unfollow with a structured failed result if `ownHandle` is absent or invalid; do not silently use the target profile.

- [ ] **Step 4: Persist and compose the authenticated handle**

```js
const nextConnection = {
  baseUrl,
  pairingToken,
  accountId: account.accountId,
  normalizedHandle: account.normalizedHandle,
};
```

Pass `ownHandle: connection.normalizedHandle` into `createInstagramRelationshipGateway` inside `composeRemoteRuntime`. For older connections without that field, pass `getOwnHandle: async () => (await client.getAccount()).normalizedHandle`; cache the successful lookup in the gateway closure. The loopback `GET /v1/account` endpoint reads only the normalized handle for the account identified by the existing account header. This keeps existing pairings usable without exposing the pairing token or asking the user to reconnect.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/background-followup.test.mjs`

Expected: PASS, including the direct-profile follow gateway test and the new Following-list unfollow test.

- [ ] **Step 6: Commit**

```bash
git add extension/background.js test/background-followup.test.mjs
git commit -m "fix: route unfollows through Following list"
```

### Task 2: Preserve row-only safety in the injected action

**Files:**
- Modify: `extension/instagram-follow-actions.js:405-433` only if a failing test exposes an unhandled route/list condition.
- Test: `test/instagram-follow-actions.test.mjs:676-955`

**Interfaces:**
- Consumes: `/own-handle/following/` page containing an Instagram relationship dialog.
- Produces: only `succeeded`, `already_desired`, or a non-actionable `failed`/`skipped` result; it never clicks an unrelated suggestion/profile control.

- [ ] **Step 1: Add a failing regression only if needed**

```js
test("does not fall back to a profile control when the Following list lacks alice", async () => {
  const unrelated = relationshipButton("Following");
  const dialog = new FakeElement("div", { attributes: { role: "dialog" } });
  dialog.append(unrelated);
  const restore = installDom({ pathname: "/alban.automation/following/", roots: [dialog] });
  try {
    const result = await performInstagramRelationshipAction({ expectedHandle: "alice", action: "unfollow" });
    assert.equal(result.status, "skipped");
    assert.equal(unrelated.clicks, 0);
  } finally { restore(); }
});
```

- [ ] **Step 2: Run the focused regression**

Run: `node --test test/instagram-follow-actions.test.mjs --test-name-pattern="Following list lacks alice"`

Expected: FAIL only if the implementation can click the unrelated control; otherwise retain the existing passing protection and do not change production code.

- [ ] **Step 3: Implement the smallest row-bound fix if RED occurred**

Keep all control lookup inside `findFollowingListRow(expectedHandle)` and return the existing skipped result when no exact canonical anchor is found.

- [ ] **Step 4: Run the action suite**

Run: `node --test test/instagram-follow-actions.test.mjs`

Expected: PASS, including EN/FR labels, confirmation, row disappearance, and no cross-row action.

- [ ] **Step 5: Commit only changed files**

```bash
git add extension/instagram-follow-actions.js test/instagram-follow-actions.test.mjs
git commit -m "test: lock unfollows to exact Following rows"
```

### Task 3: Reload and test one real two-account batch

**Files:**
- Modify: none unless a fresh failing automated regression identifies a code defect.
- Test: `test/background-followup.test.mjs`, `test/instagram-follow-actions.test.mjs`, full `npm test`.

- [ ] **Step 1: Verify state is stopped before testing**

Read the local engine state and require `automationEnabled === false` and `run.phase === "stopped"`.

- [ ] **Step 2: Reload the extension**

Use `reload-unpacked-chrome-extension` and require Chrome's “Extension actualisée” confirmation.

- [ ] **Step 3: Start the real two-account batch and monitor persisted history**

Start Autopilot with Computer Use. Inspect the local engine after the first outcome and after the second; require a row-targeted outcome for each selected handle.

- [ ] **Step 4: Stop the autopilot after the pair**

Persist `automationEnabled: false`, `run.phase: "stopped"`, and clear current scheduling fields. Verify the resulting revision and state.

- [ ] **Step 5: Run full regression verification**

Run: `npm test && git diff --check`

Expected: all suites pass and no whitespace errors.

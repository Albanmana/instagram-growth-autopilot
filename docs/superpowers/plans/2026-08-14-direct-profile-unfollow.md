# Direct Profile Unfollow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute each queued unfollow from the exact target Instagram profile rather than from the account Following list.

**Architecture:** The background gateway always opens the canonical `https://www.instagram.com/<queued-handle>/` route. The injected action only permits a click when the pathname equals that handle and the profile relationship state is unambiguous; it confirms the Instagram dialog and then requires the state to become `Follow` or `Suivre` before reporting success.

**Tech Stack:** Manifest V3, `chrome.scripting.executeScript`, DOM-only adapter, Node built-in test runner.

## Global Constraints

- No API, credential, remote queue, or unrelated control is used.
- Success requires the exact profile route, Instagram confirmation, and final `Follow`/`Suivre` state.
- Reload Chrome's unpacked extension and require `Extension actualisée` before live testing.
- Re-test only the two already-authorized candidates and inspect persisted outcomes.

---

### Task 1: Route unfollow to the target profile

**Files:**

- Modify: `extension/background.js:156-191`
- Test: `test/background-followup.test.mjs:444-491`

**Interfaces:**

- Consumes: `performRelationshipAction({ expectedHandle, action, actionContext })`.
- Produces: `openTabAndWait("https://www.instagram.com/<expectedHandle>/", true, { waitForComplete: true })` for follows and unfollows.

- [ ] **Step 1: Write the failing test**

```js
await gateway({ expectedHandle: "alice", action: "unfollow" });
assert.deepEqual(opened, ["https://www.instagram.com/alice/"]);
```

- [ ] **Step 2: Verify RED**

Run `node --test test/background-followup.test.mjs`; it must fail because the current code opens `/alban.automation/following/`.

- [ ] **Step 3: Implement the minimal routing change**

```js
profileUrl = normalizeSourceInput(expectedHandle);
```

Remove the authenticated-handle branch because a direct profile action does not use it.

- [ ] **Step 4: Verify GREEN**

Run `node --test test/background-followup.test.mjs`.

### Task 2: Keep the direct-profile safety boundary

**Files:**

- Modify: `extension/instagram-follow-actions.js:336-393`
- Test: `test/instagram-follow-actions.test.mjs:403-585`

**Interfaces:**

- Consumes: `performInstagramRelationshipAction({ expectedHandle, action: "unfollow" })`.
- Produces: `{ status: "succeeded" }` only after the exact confirmation and a visible final Follow/Suivre control.

- [ ] **Step 1: Retain an exact-profile regression**

```js
assert.equal(result.status, "succeeded");
assert.equal(profileControl.clicks, 1);
assert.equal(suggestionControl.clicks, 0);
```

- [ ] **Step 2: Remove unreachable Following-list fallback**

```js
if (!onExpectedProfile) return skipped("The loaded profile does not match the queued handle.");
```

- [ ] **Step 3: Verify adapter and full suite**

Run `node --test test/background-followup.test.mjs test/instagram-follow-actions.test.mjs && npm test && git diff --check`.

### Task 3: Reload and validate a live two-account run

**Files:**

- Runtime: unpacked Chrome extension and local service state.

- [ ] **Step 1: Reload the exact unpacked extension**

Use `reload-unpacked-chrome-extension` and require Chrome's `Extension actualisée` toast.

- [ ] **Step 2: Requeue only the two prior skipped test candidates**

Use the service's CAS endpoint while preserving immutable history and all other candidates.

- [ ] **Step 3: Start the normal action lane and inspect persisted state**

Read `/v1/engine-state` during and after the batch, then stop the lane.

- [ ] **Step 4: Classify evidence conservatively**

Mark success only where the adapter observed final Follow/Suivre state; retain all other outcomes explicitly.

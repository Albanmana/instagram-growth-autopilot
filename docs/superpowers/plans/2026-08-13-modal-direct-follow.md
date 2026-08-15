# Modal Direct Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow eligible visible followers directly within the supplied source profile's Followers modal for both Manual and Auto collection.

**Architecture:** Add a modal-scoped DOM adapter that scrolls the bound Followers dialog and performs one verified row-local follow at a time. The persistent engine consumes those outcomes rather than creating a `pending_follow` backlog, while keeping delays, Stop/Pause, history, and delayed unfollows.

**Tech Stack:** Manifest V3 JavaScript modules, `chrome.scripting`, `chrome.storage.local`, Node built-in test runner.

## Global Constraints

- The direct modal path applies to both `RUN_MANUAL_SOURCE` and automatic source collection.
- Only a visible row-local `Suivre`/`Follow` control may be clicked; `Suivi(e)`/`Following` is a skip.
- A success requires the same row's control to change visibly to `Suivi(e)`/`Following`.
- The configured 10–20 second delay is honored between all terminal row outcomes.
- The adapter stays bound to the canonical source profile and its newly opened Followers dialog.
- Owner-only/preview warnings remain persisted and only visible rows are processed.
- No profile-per-follower follow tab is opened by this direct follow collection path.
- No real Instagram follow is performed by automated tests.

---

### Task 1: Add a verified direct-follow modal adapter

**Files:**
- Modify: `extension/instagram-followers.js`
- Modify: `test/instagram-followers.test.mjs`

**Interfaces:**
- Produces `collectAndFollowFollowers({ profileUrl, limit, onOutcome, signal })` from `createInstagramFollowers`.
- `onOutcome({ handle, profileUrl, displayName, status, reason, at })` is awaited once per visible row terminal outcome.
- Returns `{ processedCount, warning }`.

- [ ] **Step 1: Write failing adapter tests**

```js
test("follows a visible Followers row only after its same-row label changes", async () => {
  const adapter = createInstagramFollowers(browserModalWithRows([
    { handle: "alice", label: "Suivre", afterClickLabel: "Suivi(e)" },
  ]));
  const outcomes = [];
  await adapter.collectAndFollowFollowers({
    profileUrl: "@source", limit: 1, onOutcome: async (outcome) => outcomes.push(outcome),
  });
  assert.deepEqual(outcomes.map(({ status }) => status), ["succeeded"]);
});
```

- [ ] **Step 2: Verify RED**

Run `node --test test/instagram-followers.test.mjs`; the new test fails because the method does not exist.

- [ ] **Step 3: Implement the smallest DOM loop**

```js
async function collectAndFollowFollowers({ profileUrl, limit, onOutcome, signal }) {
  // Bind the existing canonical Followers dialog.
  // Process one unseen canonical row, then await onOutcome before advancing.
  // Success needs the same row's Following/Suivi(e) label after its click.
}
```

Use a per-run processed-handle set, and emit `skipped` for an already-followed row and `failed` for missing or ambiguous row controls.

- [ ] **Step 4: Verify GREEN**

Run `node --test test/instagram-followers.test.mjs`; all adapter tests pass.

- [ ] **Step 5: Commit**

Run `git add extension/instagram-followers.js test/instagram-followers.test.mjs && git commit -m "feat: follow visible followers directly in modal"`.

### Task 2: Persist direct modal outcomes through the engine

**Files:**
- Modify: `extension/followup-engine.js`
- Modify: `extension/background.js`
- Modify: `test/followup-engine.test.mjs`
- Modify: `test/background-followup.test.mjs`

**Interfaces:**
- Engine accepts `collectAndFollowFollowers` alongside `collectFollowers`.
- Each direct outcome creates/updates its candidate and immutable history immediately.
- Background composes the new adapter method; direct follow collection never invokes the profile action gateway.

- [ ] **Step 1: Write failing engine/runtime tests**

```js
test("Manual and Auto persist direct modal follows without profile gateway calls", async () => {
  const harness = createEngineHarness({ directOutcomes: [{ handle: "alice", status: "succeeded" }] });
  await harness.engine.runManualSource("instagram-source:source");
  assert.equal((await harness.engine.getState()).candidates[0].status, "followed");
  assert.equal(harness.calls.performAction.length, 0);
});
```

- [ ] **Step 2: Verify RED**

Run `node --test test/followup-engine.test.mjs test/background-followup.test.mjs`; the test fails because collection only returns a static candidate payload.

- [ ] **Step 3: Implement direct-outcome persistence**

```js
function applyDirectModalOutcome(state, raw, sourceId, completedAt) {
  // Normalize and merge the candidate. A succeeded direct follow becomes
  // followed with followedAt/unfollowDueAt; skipped and failed append history.
}
```

Persist each outcome before allowing the adapter to advance. Schedule the configured action delay through the engine after each outcome. Stop/Pause aborts the adapter and retains the next safe deadline.

- [ ] **Step 4: Verify targeted and full suite**

Run `npm test && git diff --check`; all tests pass and direct collection has zero profile gateway calls.

- [ ] **Step 5: Commit**

Run `git add extension/followup-engine.js extension/background.js test/followup-engine.test.mjs test/background-followup.test.mjs && git commit -m "feat: persist direct modal follow outcomes"`.

### Task 3: Update dashboard and documentation

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `test/sidepanel.test.mjs`

- [ ] **Step 1: Write a failing UI copy assertion**

```js
test("manual collection describes direct Followers-modal processing", async () => {
  assert.match(await readPanelHtml(), /visible followers.*directly/i);
});
```

- [ ] **Step 2: Verify RED**

Run `node --test test/sidepanel.test.mjs`; the assertion fails against the old generic copy.

- [ ] **Step 3: Update copy and docs**

Describe direct action on visible Followers rows, configured spacing, local history, and partial preview handling. Keep delayed-unfollow documentation accurate.

- [ ] **Step 4: Verify and commit**

Run `npm test && git diff --check`, then `git add extension/sidepanel.html README.md docs/architecture.md test/sidepanel.test.mjs && git commit -m "docs: describe direct modal follow collection"`.

## Final Verification

- [ ] Run `npm test` and record the passing count.
- [ ] Run `git diff --check`.
- [ ] Confirm direct modal collection invokes no profile action gateway for Follow.
- [ ] Confirm no state-changing Instagram smoke test is performed without separate explicit authorization.

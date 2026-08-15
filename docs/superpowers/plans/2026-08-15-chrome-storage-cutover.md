# Chrome Storage Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained Instagram Growth Autopilot whose durable state, retries, and scheduling use Chrome Storage only, with the existing paired Supabase state preserved through a verified one-time migration.

**Architecture:** A versioned Chrome Storage store becomes the only runtime store. A pure migration module converts either a legacy local snapshot or a remote snapshot supplied during the controlled cutover into the new canonical state, validates readback, and preserves a backup. The background owns an explicit health/retry controller and recreates due alarms; the final package contains no HTTP client, Supabase code, server configuration, or loopback permission.

**Tech Stack:** Chrome Manifest V3, `chrome.storage.local`, `chrome.alarms`, JavaScript ES modules, Node.js built-in test runner, Playwright extension contract tests.

## Global Constraints

- The final package has no Supabase, Docker, Node server, loopback host permission, pairing token, or `127.0.0.1` reference.
- The canonical state is `instagramGrowthAutopilotState` schema version `2`; state writes are normalized and serialized.
- Any ambiguous interrupted Instagram follow/unfollow action is skipped and logged, never replayed automatically.
- All new behavior starts with a focused failing test and finishes with its focused passing test.
- No verification step performs a live Instagram follow or unfollow.
- Docker volumes are not deleted by this work.

---

## File Structure

- `extension/followup-store.js`: version-2 canonical store, legacy local-key migration, export/import validation.
- `extension/followup-migration.js`: pure snapshot conversion, checksum, backup, and idempotent migration receipt.
- `extension/followup-health.js`: persisted retry/backoff, health classification, and notification de-duplication.
- `extension/background.js`: local-only runtime, startup migration orchestration, alarm reconciliation, and error-to-health conversion.
- `extension/sidepanel.{html,js,css}`: local-only settings plus persistent operational status and retry controls.
- `extension/manifest.json`: required Chrome permissions only.
- `test/followup-{store,migration,health}.test.mjs`: unit coverage of data and recovery boundaries.
- `test/background-followup.test.mjs` and `test/sidepanel.test.mjs`: MV3 and UI contract coverage.
- `test/e2e/run-extension-e2e.mjs`: final package/no-loopback E2E assertions.

### Task 1: Versioned local store and import contract

**Files:**
- Modify: `extension/followup-store.js`
- Modify: `test/followup-store.test.mjs`

**Interfaces:**
- Produces `INSTAGRAM_GROWTH_STATE_KEY = "instagramGrowthAutopilotState"`.
- Produces `normalizeGrowthState(rawState, now, { allowMissing, migrateLegacy })` returning schema version `2`.
- Extends `createFollowupStore()` with `importJson(json)` and `getStorageBytesInUse()`.

- [ ] **Step 1: Write failing store tests**

```js
test("migrates a version-1 local state into the version-2 growth key", async () => {
  const storage = memoryStorage({ instagramFollowupState: legacyState });
  const store = createFollowupStore({ storage, now: () => new Date(NOW) });
  const state = await store.load();
  assert.equal(state.version, 2);
  assert.deepEqual(state.candidates, legacyState.candidates);
  assert.ok((await storage.get(["instagramGrowthAutopilotState"])).instagramGrowthAutopilotState);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test test/followup-store.test.mjs`

Expected: FAIL because the version-2 state key and migration do not exist.

- [ ] **Step 3: Implement the normalized v2 store**

```js
export const INSTAGRAM_GROWTH_STATE_KEY = "instagramGrowthAutopilotState";

export function normalizeGrowthState(rawState, now, options = {}) {
  const normalizedV1 = normalizeFollowupState(rawState, now, options);
  return { ...normalizedV1, version: 2 };
}
```

`load()` first reads the v2 key, then reads the legacy key only when v2 is absent; it writes the normalized v2 result before returning it. `save()`, `update()`, export, reset, and import use only the v2 key. `importJson` rejects malformed JSON, unsupported versions, and non-object payloads before any write.

- [ ] **Step 4: Run focused store tests to verify GREEN**

Run: `node --test test/followup-store.test.mjs`

Expected: PASS including pre-existing local-store behavior and the v1-to-v2 migration.

- [ ] **Step 5: Commit**

```bash
git add extension/followup-store.js test/followup-store.test.mjs
git commit -m "feat: version local growth state"
```

### Task 2: Verified remote-snapshot migration boundary

**Files:**
- Create: `extension/followup-migration.js`
- Create: `test/followup-migration.test.mjs`
- Modify: `extension/followup-store.js`

**Interfaces:**
- Produces `runGrowthMigration({ storage, store, readLegacySnapshot, now, sha256 })`.
- Produces receipt key `instagramGrowthAutopilotMigration` and backup key `instagramGrowthAutopilotBackup`.
- Returns `{ status: "completed" | "blocked", state?, receipt }`.

- [ ] **Step 1: Write failing migration tests**

```js
test("writes, reads back, and checksums a remote snapshot before completing", async () => {
  const result = await runGrowthMigration({ storage, store, readLegacySnapshot: async () => remoteState, now, sha256 });
  assert.equal(result.status, "completed");
  assert.equal((await storage.get([BACKUP_KEY]))[BACKUP_KEY].version, 2);
  assert.equal((await storage.get([RECEIPT_KEY]))[RECEIPT_KEY].status, "completed");
});

test("keeps a failed readback migration incomplete without overwriting canonical state", async () => {
  await assert.rejects(() => runGrowthMigration({ storage: corruptingStorage, store, readLegacySnapshot, now, sha256 }), /checksum/);
  assert.equal((await storage.get([RECEIPT_KEY]))[RECEIPT_KEY].status, "blocked");
});
```

- [ ] **Step 2: Run focused test to verify RED**

Run: `node --test test/followup-migration.test.mjs`

Expected: FAIL because the migration module is absent.

- [ ] **Step 3: Implement idempotent conversion and receipt persistence**

Use `crypto.subtle.digest("SHA-256", TextEncoder.encode(stableJson(state)))` in production and dependency injection in tests. Set the receipt to `copying` before reading the source. Normalize through the store, write the backup and canonical state, read canonical state, compare counts plus stable checksum, then set `verified` and `completed`. Preserve source failures as `blocked`; do not delete any legacy key here.

- [ ] **Step 4: Run focused migration tests to verify GREEN**

Run: `node --test test/followup-migration.test.mjs test/followup-store.test.mjs`

Expected: PASS, including restart/idempotence and an unsupported-version refusal.

- [ ] **Step 5: Commit**

```bash
git add extension/followup-migration.js extension/followup-store.js test/followup-migration.test.mjs
git commit -m "feat: verify growth state migration"
```

### Task 3: Persisted health and retry controller

**Files:**
- Create: `extension/followup-health.js`
- Create: `test/followup-health.test.mjs`

**Interfaces:**
- Produces `HEALTH_KEY = "instagramGrowthAutopilotHealth"`.
- Produces `createFollowupHealth({ storage, now, notify })` with `recordSuccess()`, `recordFailure(error)`, and `get()`.
- Recoverable retries use delays `[60_000, 300_000, 900_000, 3_600_000]` milliseconds.

- [ ] **Step 1: Write failing health tests**

```js
test("escalates recoverable failures through the durable retry schedule", async () => {
  assert.equal((await health.recordFailure(new Error("tab closed"))).nextRetryAt, plus(NOW, 60_000));
  assert.equal((await health.recordFailure(new Error("tab closed"))).nextRetryAt, plus(NOW, 300_000));
});

test("notifies once when authentication becomes intervention-required", async () => {
  await health.recordFailure(new Error("Instagram session is unavailable"));
  await health.recordFailure(new Error("Instagram session is unavailable"));
  assert.equal(notifications.length, 1);
});
```

- [ ] **Step 2: Run focused test to verify RED**

Run: `node --test test/followup-health.test.mjs`

Expected: FAIL because the health module is absent.

- [ ] **Step 3: Implement classification and durable telemetry**

Classify login/challenge/unsupported-schema/storage quota failures as `intervention_required`; classify tab/navigation/network failures as `retry_scheduled`. `recordSuccess` resets failures and clears notification state. Persist only safe error messages, never raw DOM/credential data. Return the computed retry deadline.

- [ ] **Step 4: Run focused health tests to verify GREEN**

Run: `node --test test/followup-health.test.mjs`

Expected: PASS with de-duplicated notification assertions.

- [ ] **Step 5: Commit**

```bash
git add extension/followup-health.js test/followup-health.test.mjs
git commit -m "feat: persist autopilot health retries"
```

### Task 4: Local-only background lifecycle and alarm recovery

**Files:**
- Modify: `extension/background.js`
- Modify: `test/background-followup.test.mjs`
- Modify: `extension/manifest.json`

**Interfaces:**
- Removes `composeRemoteRuntime`, pairing message types, and service-client imports.
- Adds `INSTAGRAM_GROWTH_RETRY = "INSTAGRAM_GROWTH_RETRY"`.
- `installFollowupBackground()` always composes `composeLocalRuntime()` and exposes `{ ready }` only after migration/startup reconciliation completes.

- [ ] **Step 1: Write failing background tests**

```js
test("startup recreates an overdue local alarm and records a healthy reconciliation", async () => {
  const { background, alarms, health } = installBackgroundHarness({ dueAt: PAST });
  await background.ready;
  assert.equal(health.status, "healthy");
  assert.equal(alarms.created[0].name, INSTAGRAM_FOLLOWUP_NEXT_WORK);
});

test("a due-work rejection schedules a durable retry instead of only logging", async () => {
  const { alarms, health } = installBackgroundHarness({ runDueWork: async () => { throw new Error("tab closed"); } });
  await alarms.emit({ name: INSTAGRAM_FOLLOWUP_NEXT_WORK });
  assert.equal(health.status, "retry_scheduled");
  assert.equal(alarms.created.at(-1).name, "INSTAGRAM_GROWTH_RETRY");
});
```

- [ ] **Step 2: Run focused test to verify RED**

Run: `node --test test/background-followup.test.mjs`

Expected: FAIL because the remote branch and console-only error path still exist.

- [ ] **Step 3: Implement the local-only lifecycle**

Create the store and engine once. Call `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` when available. Wrap `reconcileStartup`, `runDueWork`, and all local messages in `runWithHealth(operation)`: record success after completion; on recoverable failure create `INSTAGRAM_GROWTH_RETRY` at `nextRetryAt`; on intervention failure do not schedule Instagram work. The retry alarm calls only `engine.reconcileStartup()` then `engine.runDueWork()` through the same wrapper.

Remove `@supabase` runtime imports, remote composition, pairing, live accelerated server testing, connection store usage, and loopback host permission. Add `notifications` and `unlimitedStorage` permissions.

- [ ] **Step 4: Run focused background tests to verify GREEN**

Run: `node --test test/background-followup.test.mjs test/followup-health.test.mjs`

Expected: PASS with no remote-runtime test retained.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js extension/manifest.json test/background-followup.test.mjs
git commit -m "feat: make autopilot runtime local only"
```

### Task 5: Operator status and local import/export UI

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js`
- Modify: `extension/sidepanel.css`
- Modify: `test/sidepanel.test.mjs`

**Interfaces:**
- Background messages: `GET_FOLLOWUP_HEALTH`, `RETRY_FOLLOWUP_WORK`, `IMPORT_FOLLOWUP_STATE`.
- `renderHealth(health)` renders operational, retry, and intervention states without hiding the last known snapshot.

- [ ] **Step 1: Write failing UI tests**

```js
test("settings contains no local-service pairing controls", async () => {
  await loadPanel();
  assert.equal(document.querySelector("#pair-local-service"), null);
  assert.equal(document.body.textContent.includes("Supabase"), false);
});

test("a retry-scheduled health response shows its deadline and sends retry intent", async () => {
  await render({ health: { status: "retry_scheduled", nextRetryAt: FUTURE } });
  assert.match(document.body.textContent, /Retry scheduled/i);
  document.querySelector("#retry-autopilot").click();
  assert.equal(messages.at(-1).type, "RETRY_FOLLOWUP_WORK");
});
```

- [ ] **Step 2: Run focused test to verify RED**

Run: `node --test test/sidepanel.test.mjs`

Expected: FAIL because the pairing UI is still present and health is not rendered.

- [ ] **Step 3: Implement status and import/export controls**

Remove the service pairing form and all references to Supabase. Add a persistent `#autopilot-health` region with retry/intervention text and retry button. Extend the existing export control to include state schema v2. Add an explicit JSON-file import control that sends `IMPORT_FOLLOWUP_STATE`; it shows validation errors without replacing the rendered state.

- [ ] **Step 4: Run focused UI tests to verify GREEN**

Run: `node --test test/sidepanel.test.mjs`

Expected: PASS with settings, health, import, and existing lifecycle coverage.

- [ ] **Step 5: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js extension/sidepanel.css test/sidepanel.test.mjs
git commit -m "feat: expose autopilot health locally"
```

### Task 6: Delete service/Supabase code and prove packaging boundary

**Files:**
- Delete: `extension/followup-service-client.js`
- Delete: `extension/followup-remote-store.js`
- Delete: `extension/followup-connection-store.js`
- Delete: `extension/live-accelerated-test.js`
- Delete: `local-service/`
- Delete: `supabase/`
- Delete: service/remote/live-test test files
- Modify: `package.json`, `package-lock.json`, `docs/architecture.md`, `README.md`, `test/e2e/run-extension-e2e.mjs`

**Interfaces:**
- Produces a package with only local extension runtime files and no loopback/Supabase strings.

- [ ] **Step 1: Write failing final-boundary test**

```js
test("the distributable extension has no Supabase, service, or loopback dependency", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(Object.hasOwn(packageJson.dependencies || {}, "@supabase/supabase-js"), false);
  assert.doesNotMatch(await readFile("extension/manifest.json", "utf8"), /127\.0\.0\.1|Supabase/);
  assert.equal(await exists("local-service"), false);
  assert.equal(await exists("supabase"), false);
});
```

- [ ] **Step 2: Run focused boundary test to verify RED**

Run: `node --test test/e2e-runner-contract.test.mjs`

Expected: FAIL because Supabase/server code remains.

- [ ] **Step 3: Remove the retired code and dependencies**

Use `npm uninstall @supabase/supabase-js`; remove the retired files with recoverable repository deletion after the tests no longer import them. Remove server scripts, test scripts, stale UI copy, and documentation. Retain the externally saved JSON migration backup and do not delete Docker volumes.

- [ ] **Step 4: Run package and extension verification**

Run: `npm test && npm run test:e2e && rg -n -i "supabase|127\\.0\\.0\\.1|local-service|pairing token" --glob '!docs/superpowers/**' --glob '!package-lock.json' .`

Expected: all tests pass and the search returns no runtime/package references.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove Supabase control plane"
```

### Task 7: Controlled local data cutover and final acceptance

**Files:**
- Create (ignored): local JSON migration backup outside the package
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Produces a documented import procedure and verification evidence with no live Instagram action.

- [ ] **Step 1: Read and hash the legacy snapshot without modifying it**

Run: `npm run service:start` in the legacy checkout, then use its authenticated read endpoint to save a normalized JSON snapshot outside the repository and calculate its SHA-256 hash. Record source/candidate/history counts without printing pairing credentials.

- [ ] **Step 2: Verify local import and persisted alarms**

Run the final extension from the currently installed extension path; import the JSON snapshot through the explicit local import message; reload the extension; compare checksum, counts, settings, automation state, and all `next*At` values. Ensure no Instagram action is run.

- [ ] **Step 3: Stop the legacy services and run final tests**

Stop the Node service and local Supabase project. Run: `npm test && npm run test:e2e`. Confirm port `4317` is not listening before exercising the read-only UI/E2E contract.

- [ ] **Step 4: Commit documentation evidence**

```bash
git add README.md docs/architecture.md
git commit -m "docs: document standalone growth autopilot"
```

## Plan Self-Review

- Spec coverage: Tasks 1-2 cover state preservation and readback; Task 3 covers persisted retries; Task 4 covers alarm and worker lifecycle; Task 5 covers operator visibility; Task 6 removes every runtime dependency; Task 7 verifies the actual cutover without a live Instagram action.
- No placeholders: every task declares paths, interfaces, a red command, a concrete implementation direction, a green command, and a commit boundary.
- Type consistency: the state key, receipt key, health key, message names, and retry alarm names remain identical in all tasks.

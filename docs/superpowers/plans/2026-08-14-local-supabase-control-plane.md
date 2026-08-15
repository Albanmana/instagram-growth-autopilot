# Local Supabase Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a loopback local Supabase service the durable scheduler and source of truth while Chrome remains the only Instagram DOM executor.

**Architecture:** A Node loopback service holds the Supabase service key, validates commands, persists a single global account lane, and exposes claimable browser tasks. The MV3 background becomes a paired HTTP bridge: it forwards panel intents, claims one durable task, invokes the existing DOM adapters, and reports a verified outcome. Chrome storage retains only connection configuration and a display cache.

**Tech Stack:** Node.js ESM and `node:http`; Supabase CLI/Postgres; `@supabase/supabase-js`; Chrome Manifest V3; existing Node test runner and Playwright.

## Global Constraints

- The service listens on `127.0.0.1` only; never bind a LAN interface.
- The Supabase service-role key is confined to ignored service environment files; neither extension nor export contains it.
- The initial implementation supports one account but every persisted relation carries `instagram_account_id`.
- All Instagram collection/action code remains in the extension; the service never stores Instagram sessions, cookies, or credentials.
- Each account may have at most one claimed/started browser task at a time.
- A task with an unknown browser-side result becomes `requires_confirmation`; it is never automatically replayed.
- A private `Requested`/`Demandé` UI result is a successful `follow_request_sent` event, distinct from `followed`.
- Follow-back negative evidence is accepted only from a complete own-Followers collection.
- Add tests before implementation for every new behavior; run focused tests before each commit and the complete suite before handoff.

---

### Task 1: Local Supabase project and schema

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/migrations/202608140001_local_followup_control_plane.sql`
- Create: `local-service/.env.example`
- Create: `local-service/config.mjs`
- Create: `test/local-service-config.test.mjs`

**Interfaces:**
- Produces a local database schema with `instagram_accounts`, `automation_settings`, `automation_runs`, `sources`, `candidates`, `candidate_sources`, `browser_tasks`, `action_history`, and `legacy_imports`.
- Produces `loadServiceConfig(env)` returning `{ host, port, supabaseUrl, supabaseServiceRoleKey, pairingToken }` or throwing on malformed/unsafe configuration.

- [ ] **Step 1: Write failing configuration tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadServiceConfig } from "../local-service/config.mjs";

test("local service only accepts loopback and a sufficiently random pairing token", () => {
  assert.throws(() => loadServiceConfig({ FOLLOWUP_SERVICE_HOST: "0.0.0.0" }), /127\.0\.0\.1/);
  assert.throws(() => loadServiceConfig({ FOLLOWUP_SERVICE_HOST: "127.0.0.1", FOLLOWUP_PAIRING_TOKEN: "short" }), /pairing token/);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test test/local-service-config.test.mjs`

Expected: FAIL because `local-service/config.mjs` does not exist.

- [ ] **Step 3: Add the SQL migration and strict configuration loader**

Create canonical UUID primary keys and timestamp columns. Add unique constraints
on `(instagram_account_id, normalized_handle)` for both sources and candidates,
one `automation_runs` row per account, task status/action check constraints,
and foreign keys for every relationship. Add a partial unique index that allows
only one `browser_tasks` row in `claimed` or `started` for an account. Make
`action_history` append-only by granting no update/delete policy to the local
service role. Implement:

```js
export function loadServiceConfig(env = process.env) {
  const host = env.FOLLOWUP_SERVICE_HOST || "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("FOLLOWUP_SERVICE_HOST must be 127.0.0.1.");
  const port = Number(env.FOLLOWUP_SERVICE_PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("FOLLOWUP_SERVICE_PORT must be a valid local port.");
  if (!/^[A-Za-z0-9_-]{32,}$/.test(env.FOLLOWUP_PAIRING_TOKEN || "")) throw new Error("A 32-character pairing token is required.");
  // validate both Supabase variables as non-empty strings before returning.
}
```

- [ ] **Step 4: Run schema/config tests and inspect the migration**

Run: `node --test test/local-service-config.test.mjs && supabase db reset --local`

Expected: tests PASS and the migration applies on local Supabase. If the CLI is
not installed, run `npx supabase@latest db reset --local` after asking for any
required dependency/download approval.

- [ ] **Step 5: Commit**

```bash
git add supabase local-service test/local-service-config.test.mjs
git commit -m "feat: add local follow-up database schema"
```

### Task 2: Transactional repository and task claim fence

**Files:**
- Create: `local-service/repository.mjs`
- Create: `test/local-service-repository.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes a Supabase client exposing `.from()`, `.rpc()`, and `.schema()`.
- Produces `createFollowupRepository(client, { now })` with `getSnapshot(accountId)`, `dispatchCommand(accountId, command)`, `claimNextTask(accountId, claimantId)`, `startTask(accountId, taskId, claimToken)`, `completeTask(accountId, taskId, claimToken, outcome)`, and `importLegacyState(accountId, legacyState, checksum)`.

- [ ] **Step 1: Write failing repository tests with a programmable fake RPC client**

```js
test("only one claimant receives the same due task", async () => {
  const repository = createFollowupRepository(fakeClient.withQueuedTask(task));
  const [first, second] = await Promise.all([
    repository.claimNextTask(accountId, "extension:A"),
    repository.claimNextTask(accountId, "extension:B"),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

test("an expired or mismatched claim token cannot complete a task", async () => {
  await assert.rejects(() => repository.completeTask(accountId, task.id, "wrong", outcome), /claim/);
});
```

- [ ] **Step 2: Run focused repository tests to verify RED**

Run: `node --test test/local-service-repository.test.mjs`

Expected: FAIL because the repository is absent.

- [ ] **Step 3: Implement RPC-backed repository operations**

Add SQL functions in the migration for atomic task claim, start, completion,
and legacy import. Claim functions must use `FOR UPDATE SKIP LOCKED` or a
single guarded update and return a random claim token only to the winner.
`completeTask` must validate task, account, status, and claim token in the same
transaction; it appends history and updates candidate/run state before exposing
the next task. Do not use client-side read-modify-write for lifecycle changes.

- [ ] **Step 4: Run focused tests and local SQL integration test**

Run: `node --test test/local-service-repository.test.mjs && npm run test:service-db`

Expected: PASS; the integration test starts against `supabase start` data and
proves concurrent claims yield exactly one winner.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations local-service/repository.mjs test/local-service-repository.test.mjs package.json
git commit -m "feat: add transactional follow-up task repository"
```

### Task 3: Control-plane command, scheduler, and recovery service

**Files:**
- Create: `local-service/domain.mjs`
- Create: `local-service/server.mjs`
- Create: `local-service/index.mjs`
- Create: `test/local-service-domain.test.mjs`
- Create: `test/local-service-server.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes `createFollowupRepository` and the pure validation/selectors from `extension/followup-model.js`.
- Produces `createControlPlane({ repository, now, random })` and
  `createLocalService({ controlPlane, config })`.
- HTTP contract: `GET /health`, `GET /v1/state`, `POST /v1/commands`,
  `POST /v1/tasks/claim`, `POST /v1/tasks/:id/start`, `POST /v1/tasks/:id/outcome`,
  and `POST /v1/migrations/legacy-state`.

- [ ] **Step 1: Write failing domain/server tests**

```js
test("paused automation never emits a task and stop cancels queued tasks", async () => {
  await controlPlane.command(accountId, { type: "PAUSE_AUTO" });
  assert.equal(await controlPlane.claim(accountId, "extension:test"), null);
  await controlPlane.command(accountId, { type: "STOP_AUTO" });
  assert.equal((await repository.getSnapshot(accountId)).run.phase, "stopped");
});

test("service rejects a request without the pairing bearer token", async () => {
  const response = await request(server, "GET", "/v1/state");
  assert.equal(response.status, 401);
});
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test test/local-service-domain.test.mjs test/local-service-server.test.mjs`

Expected: FAIL because the service modules do not exist.

- [ ] **Step 3: Implement explicit commands and durable task generation**

Implement only the existing intent names: `ADD_SOURCE`, `REMOVE_SOURCE`,
`SCAN_NOW`, `RUN_FOLLOW_BACK_REVIEW`, `START_AUTO`, `PAUSE_AUTO`,
`RESUME_AUTO`, `STOP_AUTO`, `SAVE_FOLLOWUP_SETTINGS`, `EXPORT_FOLLOWUP_STATE`,
and `RESET_FOLLOWUP_STATE`. The domain must apply the current global cadence,
source/review deadlines, batch priority, and follow-back rules, then enqueue a
single task type. Validate every command payload before persistence. Server
responses use `{ ok: true, state }` and errors use `{ ok: false, error }`.

- [ ] **Step 4: Implement unknown-result recovery**

When a claim has started but the extension cannot submit an outcome, expire it
to `requires_confirmation`; do not requeue it. Queue creation must exclude an
account with a claimed/started/recovery task. Add a health field that reports
`recovery_required` and the task reference.

- [ ] **Step 5: Run focused service tests**

Run: `node --test test/local-service-domain.test.mjs test/local-service-server.test.mjs`

Expected: PASS, including token rejection, command validation, one global lane,
and no automatic replay.

- [ ] **Step 6: Commit**

```bash
git add local-service test/local-service-domain.test.mjs test/local-service-server.test.mjs package.json
git commit -m "feat: add local follow-up control plane"
```

### Task 4: Extension loopback client and paired configuration

**Files:**
- Create: `extension/followup-service-client.js`
- Create: `extension/followup-connection-store.js`
- Create: `test/followup-service-client.test.mjs`
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`
- Modify: `test/background-followup.test.mjs`

**Interfaces:**
- Produces `createFollowupServiceClient({ fetch, baseUrl, pairingToken })` with
  `getState`, `command`, `claimTask`, `startTask`, `completeTask`, `importLegacyState`, and `health`.
- Produces `createFollowupConnectionStore({ storage })` with `loadConnection`, `saveConnection`, and `loadCachedState`.
- `composeLocalRuntime` consumes the client and exposes current background message intents unchanged to the panel.

- [ ] **Step 1: Write failing client/background tests**

```js
test("the bridge sends pairing auth only to loopback HTTPS/HTTP origins", async () => {
  await assert.rejects(() => createFollowupServiceClient({ fetch, baseUrl: "https://example.com", pairingToken }).getState(), /loopback/);
});

test("GET_FOLLOWUP_STATE is served from the durable service and updates the display cache", async () => {
  const response = await handleRuntimeMessage({ type: "GET_FOLLOWUP_STATE" });
  assert.deepEqual(response.state, serviceState);
  assert.deepEqual(await connectionStore.loadCachedState(), serviceState);
});
```

- [ ] **Step 2: Run focused test to verify RED**

Run: `node --test test/followup-service-client.test.mjs test/background-followup.test.mjs`

Expected: FAIL because the client and paired runtime path are absent.

- [ ] **Step 3: Implement loopback-only client and configuration storage**

Use `fetch` with a 10-second abort timeout. Accept only `http://127.0.0.1:<port>`
or `http://localhost:<port>` after normalizing to 127.0.0.1. Add that precise
loopback host permission to the manifest. Store only base URL, pairing token,
and read cache in Chrome storage; reject missing connection configuration with
a user-actionable message.

- [ ] **Step 4: Forward all panel intents to the service**

Keep `LOCAL_MESSAGE_TYPES` stable. Replace direct engine state mutations with
`client.command(type, payload)`. Continue exposing `GET_FOLLOWUP_STATE`, export
and reset through the same message contract. During cutover, read an existing
legacy state only for explicit export/import; never merge it silently with a
service snapshot.

- [ ] **Step 5: Run bridge tests**

Run: `node --test test/followup-service-client.test.mjs test/background-followup.test.mjs`

Expected: PASS; the test must prove no Supabase key appears in runtime messages,
storage values, or request headers.

- [ ] **Step 6: Commit**

```bash
git add extension/followup-service-client.js extension/followup-connection-store.js extension/manifest.json extension/background.js test/followup-service-client.test.mjs test/background-followup.test.mjs
git commit -m "feat: bridge extension to local follow-up service"
```

### Task 5: Browser-task executor using existing Instagram adapters

**Files:**
- Create: `extension/followup-task-executor.js`
- Create: `test/followup-task-executor.test.mjs`
- Modify: `extension/background.js`
- Modify: `extension/instagram-follow-actions.js`
- Modify: `test/instagram-follow-actions.test.mjs`

**Interfaces:**
- Produces `createFollowupTaskExecutor({ client, followers, performAction, now })` with `runOne(accountId, claimantId)`.
- Consumes claimed tasks and emits service outcomes with task ID and claim token.
- Existing `performInstagramRelationshipAction` produces `follow_request_sent` when the verified post-click label is `Requested` or `Demandé`.

- [ ] **Step 1: Write failing task-executor and requested-follow tests**

```js
test("a private account request completes its claimed follow task as follow_request_sent", async () => {
  await executor.runOne(accountId, claimantId);
  assert.deepEqual(client.completed[0].outcome, { status: "follow_request_sent", handle: "private_user" });
});

test("a second executor cannot perform a task it did not claim", async () => {
  await executor.runOne(accountId, "extension:B");
  assert.equal(performAction.calls.length, 0);
});
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test test/followup-task-executor.test.mjs test/instagram-follow-actions.test.mjs`

Expected: FAIL because the executor and requested outcome do not exist.

- [ ] **Step 3: Implement executor task routing**

Route `source_collection` to the existing direct-follow collector,
`relationship_review` to the own-Followers collector, and `follow`/`unfollow`
to the existing relationship gateway. Call `startTask` before DOM work. Send a
per-row verified result for direct collection. If a post-start exception occurs,
do not attempt a second click: submit a structured failed/unknown result and
let the service place it in confirmation.

- [ ] **Step 4: Add Requested/Demandé verification to relationship action**

Extend localized desired-state recognition to classify post-click Requested /
Demandé as `follow_request_sent` only for a `follow` action. Preserve skip and
failure semantics for every other label and keep normal `Following` / `Suivi(e)`
success distinct.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/followup-task-executor.test.mjs test/instagram-follow-actions.test.mjs test/instagram-followers.test.mjs`

Expected: PASS; assertions cover source collection, review, unfollow, private
request, and no duplicate action after claim loss.

- [ ] **Step 6: Commit**

```bash
git add extension/followup-task-executor.js extension/background.js extension/instagram-follow-actions.js test/followup-task-executor.test.mjs test/instagram-follow-actions.test.mjs
git commit -m "feat: execute durable Instagram browser tasks"
```

### Task 6: Side-panel connection, migration, and durable display

**Files:**
- Modify: `extension/sidepanel.html`
- Modify: `extension/sidepanel.js`
- Modify: `extension/sidepanel.css`
- Modify: `test/sidepanel.test.mjs`
- Modify: `extension/background.js`
- Modify: `test/background-followup.test.mjs`

**Interfaces:**
- Adds `SAVE_FOLLOWUP_CONNECTION` and `IMPORT_LEGACY_FOLLOWUP_STATE` background intents.
- The panel uses durable service snapshots for all tabs and renders an explicit connection/recovery banner.

- [ ] **Step 1: Write failing panel tests**

```js
test("the disconnected panel offers loopback pairing and never enables automation", async () => {
  render({ connection: null });
  assert.match(document.body.textContent, /Connect local service/);
  assert.equal(startButton.disabled, true);
});

test("import requires explicit confirmation and displays immutable import result", async () => {
  await click(importButton);
  assert.equal(sentMessages.at(-1).type, "IMPORT_LEGACY_FOLLOWUP_STATE");
});
```

- [ ] **Step 2: Run focused test to verify RED**

Run: `node --test test/sidepanel.test.mjs test/background-followup.test.mjs`

Expected: FAIL because pairing/import states are absent.

- [ ] **Step 3: Add minimal connection and migration UI**

Add a Settings form for local service URL and pairing token, a connection health
badge, an explicit legacy export/download followed by confirmation-gated import,
and an immutable migration receipt. Show `requires_confirmation` prominently
and disable Start/Resume until its task is resolved. Preserve the existing four
tabs and existing buttons; their data source is simply the service snapshot.

- [ ] **Step 4: Make polling task-aware**

While the panel is visible, request a snapshot and ask the background executor
to `runOne` only when connected and automation is enabled. Do not start browser
actions when the panel is hidden, disconnected, paused, stopped, or in
recovery. Live run animation and counter derive from newly completed task
history returned by service snapshots.

- [ ] **Step 5: Run focused UI tests**

Run: `node --test test/sidepanel.test.mjs test/background-followup.test.mjs`

Expected: PASS; stale read protection, connection errors, import confirmation,
and recovery visibility are covered.

- [ ] **Step 6: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js extension/sidepanel.css extension/background.js test/sidepanel.test.mjs test/background-followup.test.mjs
git commit -m "feat: show durable local service state in panel"
```

### Task 7: Legacy import, local integration, and release documentation

**Files:**
- Create: `test/local-service-integration.test.mjs`
- Create: `test/e2e/run-local-control-plane-e2e.mjs`
- Modify: `test/e2e/run-extension-e2e.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `package.json`
- Create: `docs/local-followup-service.md`

**Interfaces:**
- Produces `npm run service:start`, `npm run service:test`, and `npm run test:e2e:local`.
- Documents exact local setup, pairing, backup/import/rollback, health checks,
and how to load the unpacked extension.

- [ ] **Step 1: Write failing import and end-to-end tests**

```js
test("the same legacy JSON checksum imports once and produces the same snapshot", async () => {
  const first = await client.importLegacyState(exported, checksum);
  const second = await client.importLegacyState(exported, checksum);
  assert.equal(second.alreadyImported, true);
  assert.deepEqual(first.state, second.state);
});

test("unpacked extension reads a paired local-service snapshot and executes no Instagram navigation in fixture mode", async () => {
  await page.getByRole("button", { name: /Start Autopilot/ }).click();
  await expect(page.getByText(/Connected to local service/)).toBeVisible();
});
```

- [ ] **Step 2: Run focused integration tests to verify RED**

Run: `node --test test/local-service-integration.test.mjs && node test/e2e/run-local-control-plane-e2e.mjs`

Expected: FAIL until import endpoint, scripts, and paired runtime exist.

- [ ] **Step 3: Implement idempotent import and runnable local scripts**

Calculate a SHA-256 checksum over canonical exported JSON. Store it in
`legacy_imports`; equal checksum returns the original receipt without modifying
state, while a different checksum after a successful import requires explicit
reset. Add scripts that check Supabase health before starting the service, and
write copy-paste setup/rollback instructions.

- [ ] **Step 4: Run full verification**

Run: `npm test && npm run test:service && npm run test:e2e && npm run test:e2e:local && git diff --check`

Expected: all suites PASS. Then run `supabase status` and `curl http://127.0.0.1:4317/health` with a locally paired service; document any user-required Supabase/Docker installation step rather than claiming it ran.

- [ ] **Step 5: Commit**

```bash
git add test README.md docs package.json
git commit -m "docs: document local Supabase follow-up service"
```

## Final verification and handoff

- [ ] Run `git status --short`, `git log --oneline -7`, `npm test`, service
  integration tests, both extension E2E suites, `node --check` on changed ESM
  files, and `git diff --check`.
- [ ] Validate local setup from a clean service environment: `supabase start`,
  migrations applied, service health, extension pairing, legacy export/import,
  and a non-Instagram fixture browser task. Do not claim live Instagram action
  verification unless an authenticated user-approved run is actually observed.
- [ ] Review the migration checklist against the design spec success criteria:
  durable state, one global lane, preserved DOM adapters, durable panel metrics,
  and secret isolation.

# Chrome Storage Cutover Design

**Date:** 2026-08-15

**Status:** Approved design, ready for implementation planning

## Objective

Migrate the existing Instagram Growth Autopilot state from the paired local Node/Supabase control plane into `chrome.storage.local`, preserve all operational data, and finish with a distributable extension that has no runtime, installation, or development dependency on Supabase, Docker, or a loopback server.

The migration must not silently stop the autopilot, lose queued work, or repeat an Instagram follow/unfollow action whose outcome is uncertain.

## Current State

The extension currently selects one of two stores at service-worker startup:

- an in-extension store backed by `chrome.storage.local`; or
- a remote store backed by a Node service at `127.0.0.1`, which persists relational state in local Supabase.

When the saved connection exists, the remote store is authoritative. The extension cannot safely fall back to the old local state after a fetch failure because that local copy can be stale. The current `instagramFollowupLocalServiceSnapshot` cache key is not maintained as an authoritative copy.

The engine already persists durable action fences (`externalOperation` and `inflightAction`). On isolated service-worker activation, an ambiguous interrupted follow/unfollow action is skipped and recorded rather than repeated. That conservative behavior must remain unchanged through migration.

The observed `Failed to fetch` failure is caused by the browser extension depending on the loopback Node process while that process is not listening. Supabase can remain healthy in Docker while the separate Node process is stopped, so keeping the current architecture would preserve two independent failure points.

## Decisions

### One source of truth after cutover

The final source of truth is `chrome.storage.local`. There is no dual-write period after migration verification. Dual-write is rejected because it creates split-brain behavior and makes recovery depend on deciding which copy is newer.

### Transitional importer, absent from the final distributable

A temporary migration bridge will exist only long enough to migrate the currently paired installation. It will use the existing saved loopback connection and pairing token to read the remote snapshot. It will never write back to Supabase during migration.

After the migrated state has been verified in Chrome and runtime acceptance tests pass with the service stopped, the bridge and every Supabase/server artifact will be removed from the final working tree and extension package.

### Preserve extension identity during the automatic migration

Chrome storage is scoped to the extension ID. The migration build must therefore be loaded as an update of the currently installed unpacked extension, not as a second unpacked extension from a different path.

Before the cutover, the operator must record the current extension ID and loaded directory from the browser extension-management page. The migration build is applied to that same loaded directory and reloaded in place. A new public/store identity can be established later for distribution; future users have no Supabase data to migrate.

The final distribution process should use a stable extension identity. For Chrome Web Store development, the public key supplied by the store can be placed in the manifest `key` field so unpacked development builds match the store item ID. This is a distribution prerequisite, not a way to recover the current path-derived ID.

### No destructive deletion of historical database volumes

The repository and final extension will not use Supabase. The local Supabase project will be stopped after verification. Existing Docker volumes are not deleted as part of this implementation because deletion is irreversible. They may be removed later only after a separate, explicit approval and after the JSON migration backup has been checked.

## Storage Model

The final extension uses four namespaced keys:

| Key | Purpose |
| --- | --- |
| `instagramGrowthAutopilotState` | Versioned, canonical engine snapshot: settings, sources, candidates, run state, and history. |
| `instagramGrowthAutopilotHealth` | Last attempt/success, consecutive failures, next retry, and persistent blocking reason. |
| `instagramGrowthAutopilotMigration` | Versioned migration state and completion receipt; contains no pairing token. |
| `instagramGrowthAutopilotBackup` | Normalized pre-cutover snapshot retained locally until the operator exports and verifies a JSON backup. |

The engine state remains one aggregate rather than being split across table-like keys. One `chrome.storage.local.set()` replaces the complete normalized snapshot, which preserves the existing store's serialized-write semantics and avoids partial updates across sources, candidates, run state, and history.

The schema version is independent from the extension version. The first final schema is version `2`. The store accepts:

- the new `instagramGrowthAutopilotState` version `2`;
- the old local `instagramFollowupState` version `1` for an unpaired local-only upgrade; and
- the normalized remote engine snapshot version `1` during the one-time paired migration.

Every accepted legacy state is normalized through the domain model before being written as version `2`. Unsupported versions fail closed and do not overwrite any existing key.

At startup, the extension restricts `chrome.storage.local` to trusted extension contexts using `setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`. The final manifest requests `unlimitedStorage` to avoid the 10 MB local quota and reduce eviction risk for a growing activity history. Storage usage is still measured and surfaced in diagnostics.

## Migration State Machine

The migration receipt has these statuses:

- `pending`: a legacy paired connection exists and no verified local snapshot exists;
- `copying`: the importer has started and automation alarms are cleared;
- `verified`: the normalized snapshot was written and read back successfully;
- `completed`: the local runtime reconciled the snapshot and its required alarm was verified;
- `blocked`: migration cannot safely continue without the legacy service or operator action.

The receipt records `migrationVersion`, timestamps, attempt count, remote revision, source and stored checksums, and a sanitized error code/message. It never stores or duplicates the pairing token.

The migration algorithm is:

1. Load the migration receipt, the new state key, the legacy connection, and the legacy local key.
2. If a `completed` receipt and valid version `2` state exist, start the local runtime immediately.
3. If a legacy connection exists and migration is incomplete, clear the work alarm before contacting the remote source.
4. Read one revisioned remote snapshot without modifying it.
5. Normalize and validate the full state, including sources, candidates, history, scheduling fields, action fences, and settings.
6. Persist the normalized state as both the backup and canonical version `2` snapshot.
7. Read the canonical snapshot back, canonicalize it with stable key ordering, and compare a SHA-256 checksum with the normalized source snapshot.
8. Mark the receipt `verified` only when structural equality, checksum equality, and required collection counts all match.
9. Compose the local engine and call startup reconciliation with service-worker activation semantics. This skips any ambiguous in-flight Instagram action instead of replaying it.
10. Verify or recreate the next required Chrome alarm and mark the receipt `completed`.
11. Remove the legacy connection and cached-state keys only after the completion receipt is durable.

The algorithm is idempotent. A worker termination at any step can rerun the step. Neither `copying` nor `verified` permits Instagram work before local reconciliation completes.

If the loopback service is unavailable, the migration enters `blocked`, preserves all legacy connection data, schedules a migration-only retry, and exposes the exact recovery instruction. It must not start from a stale local state. Retries use approximately 1, 5, 15, then 60 minute delays, capped at one hour. A `Retry migration` control triggers the same idempotent path.

## Runtime Reliability After Migration

The local runtime is composed before any message or alarm is handled. Every asynchronous background entry point reports failures through a shared reliability controller rather than only calling `console.error`.

The health record contains:

- `status`: `healthy`, `retry_scheduled`, or `intervention_required`;
- `lastAttemptAt` and `lastSuccessAt`;
- `consecutiveFailures`;
- `lastErrorCode` and a safe user-facing message;
- `nextRetryAt`; and
- `lastAlarmVerifiedAt`.

Recoverable failures schedule a retry with the same 1/5/15/60-minute policy. A success clears the failure streak. Authentication loss, an Instagram challenge, an unsupported state version, exhausted Chrome storage, or a selector failure that cannot safely determine relationship state becomes `intervention_required` and triggers a Chrome notification.

The engine continues to use its durable external-operation fence. It never automatically repeats an action after service-worker termination when Instagram may already have accepted it.

The work alarm is verified and recreated:

- whenever the service worker activates;
- on browser startup;
- after extension installation or update;
- whenever the side panel requests current state;
- after each successful state transition that changes `nextWorkAt`; and
- after a recoverable failure schedules a retry.

If `nextWorkAt` is overdue when Chrome becomes available, reconciliation runs the due work immediately. The UI must state the platform limitation clearly: Chrome extensions cannot act while the browser is fully closed or the computer is asleep; delayed alarms resume when the browser/device wakes.

## User Interface

The final Settings view removes the base URL, pairing token, Instagram account provisioning, and `Connect local Supabase` controls.

The Autopilot view replaces generic transport errors with a persistent operational status:

- **Operational** — last successful cycle and next scheduled work;
- **Retry scheduled** — concise failure cause and retry countdown;
- **Intervention required** — actionable instruction and a `Retry` button;
- **Migration in progress/blocked** — visible only in the transitional migration build.

Chrome notifications are emitted only for a transition into `intervention_required`, not for every retry. Opening the panel clears the notification only after the operator has seen the persistent status; it does not erase the underlying error.

Export remains available and exports the complete versioned local state. Import validates the document and requires explicit confirmation before replacing current state. Import is the fallback for moving the developer installation to a future store ID and for disaster recovery after extension removal.

## Final Removal Scope

After live migration verification, the following must be absent from the final working tree or package:

- `extension/followup-service-client.js`;
- `extension/followup-remote-store.js`;
- `extension/followup-connection-store.js`;
- the transitional migration bridge;
- `local-service/`;
- `supabase/`;
- Supabase/server unit and database tests;
- `@supabase/supabase-js` and its transitive lockfile entries;
- `service:*` and `test:service-db` package scripts;
- `http://127.0.0.1/*` host permission;
- pairing-related message types, UI controls, copy, and styles.

The migration receipt, canonical local state, health record, local backup, export/import capability, and pure local tests remain.

The final README and architecture document describe a self-contained MV3 extension installed from one extension directory. Docker, Supabase, Node server processes, environment files, ports, and pairing tokens are not installation steps.

## Verification Strategy

### Automated tests

Tests must cover:

- successful remote version `1` to local version `2` conversion with no field or count loss;
- invalid and unsupported snapshots refusing to overwrite local data;
- checksum/readback mismatch leaving migration incomplete;
- worker termination after each durable migration step followed by an idempotent restart;
- unavailable legacy service producing a persisted blocked state and retry schedule;
- an in-flight follow and unfollow being skipped, logged, and never called again after cutover;
- legacy local-only state migration when no remote connection exists;
- storage access restricted to trusted contexts;
- alarm recreation on startup, state inspection, overdue work, and retry;
- retry backoff, reset after success, and escalation to intervention-required;
- notification deduplication;
- removal of remote message types and pairing UI;
- the extension package containing no Supabase, local-service, loopback URL, or Supabase dependency references.

The existing unit suite and non-live Playwright extension contract remain green.

### Controlled migration proof

Before final cleanup:

1. Record the installed extension ID/path and current remote summary counts.
2. Export the remote normalized snapshot to an ignored JSON backup and record its SHA-256 hash.
3. Start the legacy service and prove the source snapshot can be read.
4. Reload the migration build in place without triggering manual Instagram activity.
5. Read back local storage and compare schema version, checksum, source count, candidate count, history count, automation state, and all next-work timestamps.
6. Confirm the completion receipt and the correctly armed alarm.
7. Stop the Node service and Supabase.
8. Restart the browser, open the panel, and prove the same state and alarm survive.
9. Run a non-live due-work/restart scenario and the extension E2E contract with port `4317` unavailable.
10. Remove all transitional and Supabase code, rerun the full suite, build/package the extension, and inspect the archive contents.

No live follow or unfollow action is authorized by this verification plan. A live action test requires separate explicit approval.

### Final acceptance criteria

The work is complete only when all of the following are true:

- every remote source, candidate, history entry, setting, and scheduling field has a verified local counterpart;
- the active/paused/stopped state is preserved;
- no ambiguous Instagram action is duplicated;
- the extension resumes correctly after service-worker and browser restart;
- failures produce persisted retries or an actionable notification, never a silent stop;
- the extension operates with port `4317` closed and Supabase stopped;
- the final manifest has no loopback host permission;
- the final package and dependency graph contain no Supabase or local-service runtime code;
- installation instructions require only the extension and an authenticated Instagram browser session;
- the legacy JSON backup and migration proof are retained outside the published extension package;
- no Docker volume is deleted without separate explicit approval.

## Official Platform References

- Chrome Storage API: <https://developer.chrome.com/docs/extensions/reference/api/storage>
- Chrome Alarms API: <https://developer.chrome.com/docs/extensions/reference/api/alarms>
- Extension service-worker migration guidance: <https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers>
- Stable extension ID using the manifest key: <https://developer.chrome.com/docs/extensions/reference/manifest/key>

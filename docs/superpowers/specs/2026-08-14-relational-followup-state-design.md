# Relational Follow-up State Design

## Goal

Make the local Supabase tables authoritative for the extension's sources,
candidates, provenance, settings, action history, and scheduler state. The
extension continues to consume the existing normalized state object, but no
candidate, source, settings, or history data remains stored in
`automation_runs.state`.

## Design

`automation_runs` owns only the execution lane: enablement, phase, next work
deadlines, active batch, lease, in-flight action, safety deadline, and external
operation fence. The scalar columns already present are populated for easy
inspection; the small run-only JSON document carries the nested concurrency
objects which have no stable relational shape.

`automation_settings`, `sources`, `candidates`, `candidate_sources`, and
`action_history` become the source of truth for the rest of the engine state.
The database reconstructs the existing state contract in `followup_read_state`.
`followup_compare_and_swap_state` accepts that same contract, checks the run
revision, replaces the mutable relational projections atomically, appends only
new immutable history events, and returns the reconstructed snapshot.

## Data mapping

- `settings` maps to `automation_settings.data`.
- `sources` maps one-to-one to `sources`; its stable extension ID remains
  `source_key` while the database UUID is used by `candidate_sources`.
- `candidates` maps one-to-one to `candidates`; the stable extension candidate
  ID remains in a new unique `candidate_key` column. Lifecycle timestamps,
  status, next action and follow-back fields map to typed columns; `profile_url`
  and `handle` remain directly queryable.
- `sourceIds` maps to `candidate_sources`.
- `history` maps to append-only `action_history`: core columns remain typed and
  complete extension event fields are stored in `proof`.
- `run` maps to typed `automation_runs` fields plus `run_data` for nested
  active/concurrency metadata.

## Migration and compatibility

The migration backfills every existing `automation_runs.state` document into
the relational tables, preserving account scope and stable source/candidate
IDs. It is idempotent: a rerun upserts mutable rows, preserves provenance, and
deduplicates history by a new per-account event key. Only after backfill does
the RPC replace reads/writes with the relational projection. The legacy `state`
column remains unchanged as a rollback snapshot but is never read or written by
the new RPCs.

## Atomicity and recovery

The compare-and-swap RPC locks the account's `automation_runs` row, validates
the expected revision, replaces the relational projection inside one database
transaction, then increments the revision. A failed write leaves the previous
projection intact. Reading locks nothing and always reconstructs from the
relational rows, so Supabase Studio directly displays the same data powering the
extension.

## Verification

- Repository tests prove the RPC contract remains revisioned.
- SQL integration validates a mixed state with sources, candidates, provenance,
  settings, run fields, and history round-trips through relational tables.
- The local migration is applied without reset, then the existing paired account
  is read through the service and compared with actual table row counts.
- The extension loads the reconstructed state and its visible metrics still
  match the stored candidate lifecycle values.

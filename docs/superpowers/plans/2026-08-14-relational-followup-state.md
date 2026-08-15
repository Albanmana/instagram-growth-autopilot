# Relational Follow-up State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the remote follow-up engine state in the existing local Supabase tables rather than in `automation_runs.state`.

**Architecture:** SQL owns bidirectional projection. The read RPC reconstructs the existing engine JSON contract from relational rows; the revisioned write RPC locks one run row and atomically projects that contract back into settings, sources, candidates, provenance, history, and run fields.

**Tech Stack:** Postgres PL/pgSQL migrations, Supabase RPC client, Node.js test runner.

## Global Constraints

- The extension contract and its stable source/candidate IDs remain unchanged.
- Candidate and source data must be visible as rows in Supabase Studio.
- The existing JSON state is retained only as rollback data; new RPC reads/writes must not use it.
- One conditional write updates the complete relational projection or none of it.
- Existing paired account data is migrated in place; no Supabase reset.

---

### Task 1: Relational schema and read projection

**Files:**
- Create: `supabase/migrations/202608140005_relational_followup_state.sql`
- Test: `test/local-service-repository.test.mjs`

- [ ] Add columns for stable source/candidate/event identities and run-only JSON metadata.
- [ ] Write a failing integration test asserting `followup_read_state` reconstructs candidates and sources from rows when `automation_runs.state` is stale.
- [ ] Implement the migration's relational backfill and read projection RPC.
- [ ] Run the focused test and apply the migration to local Supabase without reset.

### Task 2: Atomic relational compare-and-swap

**Files:**
- Modify: `supabase/migrations/202608140005_relational_followup_state.sql`
- Test: `test/local-service-repository.test.mjs`

- [ ] Write failing tests for projection writes, candidate provenance, history append de-duplication, and revision conflicts.
- [ ] Replace the JSON compare-and-swap RPC body with the row-locking relational projection.
- [ ] Run focused repository tests and the full suite.

### Task 3: Service and live data verification

**Files:**
- Modify: `local-service/repository.mjs` only if the RPC response contract changes.
- Test: `test/local-service-server.test.mjs`

- [ ] Verify the loopback service returns the reconstructed state without changes to extension callers.
- [ ] Apply the additive migration to the existing local Supabase database.
- [ ] Query actual `sources`, `candidates`, `candidate_sources`, and `action_history` rows for the paired account; compare counts and follow-back metrics with the extension state.
- [ ] Reload the extension and confirm the dashboard still renders the same durable counters.

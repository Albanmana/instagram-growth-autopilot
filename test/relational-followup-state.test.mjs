import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { createClient } from "@supabase/supabase-js";

const execFileAsync = promisify(execFile);
const DATABASE_CONTAINER = "supabase_db_instagram-followup-local";
const integrationOnly = process.env.FOLLOWUP_SERVICE_DB_TEST !== "1";

test("the relational state projection retains the bounded live-test run fence", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202608140006_preserve_live_test_run_data.sql", import.meta.url), "utf8");
  assert.match(migration, /'liveTestSourceId',\s*p_state->'run'->'liveTestSourceId'/);
  assert.match(migration, /'liveTestCandidateIds',\s*p_state->'run'->'liveTestCandidateIds'/);
  assert.match(migration, /'liveTestSourceId',\s*v_run_data->'liveTestSourceId'/);
  assert.match(migration, /'liveTestCandidateIds',\s*v_run_data->'liveTestCandidateIds'/);
});

test("the relational state projection retains the persisted balanced cycle", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202608150001_preserve_balanced_cycle_run_data.sql", import.meta.url), "utf8");
  assert.match(migration, /'cycle',\s*p_state->'run'->'cycle'/);
  assert.match(migration, /'cycle',\s*v_run_data->'cycle'/);
});

function parseEnvironment(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    return match ? [[match[1], match[2].trim().replace(/^['\"]|['\"]$/g, "")]] : [];
  }));
}

async function localClient() {
  const environment = parseEnvironment(await readFile(new URL("../local-service/.env", import.meta.url), "utf8"));
  return createClient(environment.FOLLOWUP_SUPABASE_URL, environment.FOLLOWUP_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function sql(statement) {
  return execFileAsync("docker", [
    "exec", DATABASE_CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", "-c", statement,
  ]);
}

test("followup_read_state reconstructs candidates and source provenance from relational rows", { skip: integrationOnly }, async (context) => {
  const client = await localClient();
  const handle = `relational.test.${Date.now().toString(36)}`.slice(0, 30);
  const { data: provisioned, error: provisionError } = await client.rpc("followup_provision_account", { p_handle: handle });
  assert.equal(provisionError, null);
  const accountId = provisioned.accountId;
  context.after(async () => {
    await sql(`delete from public.instagram_accounts where id = '${accountId}';`);
  });

  await sql(`
    with source as (
      insert into public.sources (instagram_account_id, source_key, profile_url, normalized_handle, status, source_limit)
      values ('${accountId}', 'instagram-source:source.example', 'https://www.instagram.com/source.example/', 'source.example', 'completed', 50)
      returning id
    ), candidate as (
      insert into public.candidates (instagram_account_id, candidate_key, handle, profile_url, normalized_handle, status, follow_back_status)
      values ('${accountId}', 'instagram:follower.example', 'Follower.Example', 'https://www.instagram.com/follower.example/', 'follower.example', 'followed', 'confirmed')
      returning id
    )
    insert into public.candidate_sources (candidate_id, source_id)
    select candidate.id, source.id from candidate cross join source;
  `);

  const { data: snapshot, error: readError } = await client.rpc("followup_read_state", { p_account_id: accountId });
  assert.equal(readError, null);
  assert.deepEqual(snapshot.state.sources.map(({ id }) => id), ["instagram-source:source.example"]);
  assert.deepEqual(snapshot.state.candidates.map(({ id, handle, sourceIds, followBackStatus }) => ({ id, handle, sourceIds, followBackStatus })), [{
    id: "instagram:follower.example",
    handle: "Follower.Example",
    sourceIds: ["instagram-source:source.example"],
    followBackStatus: "confirmed",
  }]);
});

test("followup_compare_and_swap_state writes a complete state projection to relational tables", { skip: integrationOnly }, async (context) => {
  const client = await localClient();
  const handle = `projection.test.${Date.now().toString(36)}`.slice(0, 30);
  const { data: provisioned, error: provisionError } = await client.rpc("followup_provision_account", { p_handle: handle });
  assert.equal(provisionError, null);
  const accountId = provisioned.accountId;
  context.after(async () => {
    await sql(`delete from public.instagram_accounts where id = '${accountId}';`);
  });
  const { data: before, error: readError } = await client.rpc("followup_read_state", { p_account_id: accountId });
  assert.equal(readError, null);

  const state = {
    version: 1,
    automationEnabled: true,
    settings: {
      perSourceLimit: 50, backlogMaximum: 500, refillThreshold: 100, batchSize: 50,
      actionDelayMinSeconds: 10, actionDelayMaxSeconds: 20,
      batchDelayMinMinutes: 5, batchDelayMaxMinutes: 7,
      unfollowDelayDays: 2, followBackUnfollowDelayDays: 7,
    },
    sources: [{
      id: "instagram-source:projection.source",
      profileUrl: "https://www.instagram.com/projection.source/",
      limit: 50, status: "completed",
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
      collectionDepth: 1,
    }],
    candidates: [{
      id: "instagram:projection.candidate",
      handle: "Projection.Candidate",
      profileUrl: "https://www.instagram.com/projection.candidate/",
      normalizedHandle: "projection.candidate",
      sourceIds: ["instagram-source:projection.source"],
      status: "followed",
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
      followedAt: "2026-08-14T12:00:00.000Z",
      followBackStatus: "confirmed",
      followBackAt: "2026-08-14T13:00:00.000Z",
      unfollowDueAt: "2026-08-21T13:00:00.000Z",
    }],
    run: {
      phase: "waiting", activeBatch: null, nextWorkAt: "2026-08-15T12:00:00.000Z",
      cycle: { dueAt: "2026-08-15T12:00:00.000Z", stage: "unfollow" },
      liveTestSourceId: "instagram-source:projection.source",
      liveTestCandidateIds: ["instagram:projection.candidate"],
    },
    history: [{
      candidateId: "instagram:projection.candidate", action: "follow", kind: "follow",
      handle: "Projection.Candidate", sourceIds: ["instagram-source:projection.source"],
      status: "succeeded", reason: null, timestamp: "2026-08-14T12:00:00.000Z", at: "2026-08-14T12:00:00.000Z",
    }],
  };
  const { data: written, error: writeError } = await client.rpc("followup_compare_and_swap_state", {
    p_account_id: accountId, p_revision: before.revision, p_state: state,
  });
  assert.equal(writeError, null);
  assert.deepEqual(written.state.run.liveTestSourceId, "instagram-source:projection.source");
  assert.deepEqual(written.state.run.liveTestCandidateIds, ["instagram:projection.candidate"]);
  assert.deepEqual(written.state.run.cycle, { dueAt: "2026-08-15T12:00:00.000Z", stage: "unfollow" });
  const { stdout } = await sql(`
    select (select count(*) from public.sources where instagram_account_id = '${accountId}')
      || ':' || (select count(*) from public.candidates where instagram_account_id = '${accountId}')
      || ':' || (select count(*) from public.candidate_sources cs join public.candidates c on c.id = cs.candidate_id where c.instagram_account_id = '${accountId}')
      || ':' || (select count(*) from public.action_history where instagram_account_id = '${accountId}');
  `);
  assert.equal(stdout.trim(), "1:1:1:1");
});

-- The initial control-plane schema already contains the relational entities.
-- This migration makes them authoritative and retains the former JSON document
-- only as an immutable rollback receipt in legacy_imports.

alter table public.automation_runs
  add column if not exists run_data jsonb not null default '{}'::jsonb;

alter table public.sources
  add column if not exists removed_at timestamptz;

alter table public.candidates
  add column if not exists candidate_key text;

update public.candidates
set candidate_key = 'instagram:' || normalized_handle
where candidate_key is null;

alter table public.candidates
  alter column candidate_key set not null;

create unique index if not exists candidates_account_candidate_key_key
  on public.candidates (instagram_account_id, candidate_key);

alter table public.action_history
  add column if not exists event_key text;

update public.action_history
set event_key = md5(coalesce(proof, '{}'::jsonb)::text)
where event_key is null;

alter table public.action_history
  alter column event_key set not null;

create unique index if not exists action_history_account_event_key_key
  on public.action_history (instagram_account_id, event_key);

create or replace function public.followup_iso(p_value timestamptz)
returns text language sql immutable strict as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

-- Archive the pre-relational state once, then project every legacy document
-- into the existing tables. This is additive and safe to run on populated
-- local databases without a reset.
insert into public.legacy_imports (instagram_account_id, checksum, receipt)
select instagram_account_id, md5(state::text), state
from public.automation_runs
where state ? 'candidates'
on conflict (instagram_account_id, checksum) do nothing;

insert into public.automation_settings (instagram_account_id, data)
select instagram_account_id, coalesce(state->'settings', '{}'::jsonb)
from public.automation_runs
on conflict (instagram_account_id) do update
set data = excluded.data,
    revision = public.automation_settings.revision + 1;

insert into public.sources (
  instagram_account_id, source_key, profile_url, normalized_handle, status,
  source_limit, collection_depth, warning, created_at, updated_at, last_collected_at
)
select
  r.instagram_account_id,
  item->>'id',
  item->>'profileUrl',
  lower(regexp_replace(item->>'id', '^instagram-source:', '')),
  coalesce(item->>'status', 'pending'),
  coalesce(nullif(item->>'limit', '')::integer, 200),
  coalesce(nullif(item->>'collectionDepth', '')::integer, 0),
  nullif(item->>'warning', ''),
  coalesce(nullif(item->>'createdAt', '')::timestamptz, now()),
  coalesce(nullif(item->>'updatedAt', '')::timestamptz, now()),
  nullif(item->>'lastCollectedAt', '')::timestamptz
from public.automation_runs r
cross join lateral jsonb_array_elements(coalesce(r.state->'sources', '[]'::jsonb)) item
where item->>'id' is not null and item->>'profileUrl' is not null
on conflict (instagram_account_id, source_key) do update
set profile_url = excluded.profile_url,
    normalized_handle = excluded.normalized_handle,
    status = excluded.status,
    source_limit = excluded.source_limit,
    collection_depth = excluded.collection_depth,
    warning = excluded.warning,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    last_collected_at = excluded.last_collected_at,
    removed_at = null;

insert into public.candidates (
  instagram_account_id, candidate_key, handle, profile_url, normalized_handle,
  status, follow_back_status, created_at, updated_at, followed_at,
  last_follow_back_check_at, follow_back_at, follow_back_review_due_at,
  unfollow_due_at, unfollowed_at, failed_at, next_action
)
select
  r.instagram_account_id,
  item->>'id',
  item->>'handle',
  item->>'profileUrl',
  lower(coalesce(item->>'normalizedHandle', item->>'handle')),
  item->>'status',
  nullif(item->>'followBackStatus', ''),
  coalesce(nullif(item->>'createdAt', '')::timestamptz, now()),
  coalesce(nullif(item->>'updatedAt', '')::timestamptz, now()),
  nullif(item->>'followedAt', '')::timestamptz,
  nullif(item->>'lastFollowBackCheckAt', '')::timestamptz,
  nullif(item->>'followBackAt', '')::timestamptz,
  nullif(item->>'followBackReviewDueAt', '')::timestamptz,
  nullif(item->>'unfollowDueAt', '')::timestamptz,
  nullif(item->>'unfollowedAt', '')::timestamptz,
  nullif(item->>'failedAt', '')::timestamptz,
  nullif(item->>'nextAction', '')
from public.automation_runs r
cross join lateral jsonb_array_elements(coalesce(r.state->'candidates', '[]'::jsonb)) item
where item->>'id' is not null
  and item->>'handle' is not null
  and item->>'profileUrl' is not null
  and item->>'status' is not null
on conflict (instagram_account_id, normalized_handle) do update
set candidate_key = excluded.candidate_key,
    handle = excluded.handle,
    profile_url = excluded.profile_url,
    status = excluded.status,
    follow_back_status = excluded.follow_back_status,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    followed_at = excluded.followed_at,
    last_follow_back_check_at = excluded.last_follow_back_check_at,
    follow_back_at = excluded.follow_back_at,
    follow_back_review_due_at = excluded.follow_back_review_due_at,
    unfollow_due_at = excluded.unfollow_due_at,
    unfollowed_at = excluded.unfollowed_at,
    failed_at = excluded.failed_at,
    next_action = excluded.next_action;

insert into public.candidate_sources (candidate_id, source_id)
select candidate.id, source.id
from public.automation_runs r
cross join lateral jsonb_array_elements(coalesce(r.state->'candidates', '[]'::jsonb)) candidate_item
cross join lateral jsonb_array_elements_text(coalesce(candidate_item->'sourceIds', '[]'::jsonb)) source_key(value)
join public.candidates candidate
  on candidate.instagram_account_id = r.instagram_account_id
 and candidate.candidate_key = candidate_item->>'id'
join public.sources source
  on source.instagram_account_id = r.instagram_account_id
 and source.source_key = source_key.value
on conflict do nothing;

insert into public.action_history (
  instagram_account_id, candidate_id, action, outcome, reason, proof, event_key, created_at
)
select
  r.instagram_account_id,
  candidate.id,
  coalesce(item->>'action', item->>'kind', 'unknown'),
  coalesce(item->>'status', 'unknown'),
  nullif(item->>'reason', ''),
  item,
  md5(item::text),
  coalesce(nullif(item->>'timestamp', '')::timestamptz, nullif(item->>'at', '')::timestamptz, now())
from public.automation_runs r
cross join lateral jsonb_array_elements(coalesce(r.state->'history', '[]'::jsonb)) item
left join public.candidates candidate
  on candidate.instagram_account_id = r.instagram_account_id
 and candidate.candidate_key = item->>'candidateId'
on conflict (instagram_account_id, event_key) do nothing;

update public.automation_runs
set automation_enabled = coalesce((state->>'automationEnabled')::boolean, false),
    phase = coalesce(state->'run'->>'phase', 'idle'),
    next_work_at = nullif(state->'run'->>'nextWorkAt', '')::timestamptz,
    next_source_scan_at = nullif(state->'run'->>'nextSourceScanAt', '')::timestamptz,
    next_relationship_review_at = nullif(state->'run'->>'nextRelationshipReviewAt', '')::timestamptz,
    source_scan_source_id = nullif(state->'run'->>'sourceScanSourceId', ''),
    run_data = jsonb_strip_nulls(jsonb_build_object(
      'activeBatch', state->'run'->'activeBatch',
      'lease', state->'run'->'lease',
      'safetyDeadlineAt', state->'run'->'safetyDeadlineAt',
      'inflightAction', state->'run'->'inflightAction',
      'externalOperation', state->'run'->'externalOperation'
    ));

-- State is now a rollback marker only. The archived full document is in
-- legacy_imports and all subsequent state is reconstructed from tables.
update public.automation_runs
set state = jsonb_build_object('version', 1, 'storage', 'relational-v1')
where state ? 'candidates';

create or replace function public.followup_read_state(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_run public.automation_runs;
  v_settings jsonb;
  v_sources jsonb;
  v_candidates jsonb;
  v_history jsonb;
  v_state jsonb;
begin
  select * into v_run
  from public.automation_runs
  where instagram_account_id = p_account_id;
  if v_run.instagram_account_id is null then raise exception 'Instagram account is not provisioned.'; end if;

  select data into v_settings
  from public.automation_settings
  where instagram_account_id = p_account_id;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', source_key,
    'profileUrl', profile_url,
    'limit', source_limit,
    'status', status,
    'createdAt', public.followup_iso(created_at),
    'updatedAt', public.followup_iso(updated_at),
    'lastCollectedAt', public.followup_iso(last_collected_at),
    'warning', warning,
    'collectionDepth', case when collection_depth > 0 then collection_depth else null end
  )) order by created_at, id), '[]'::jsonb)
  into v_sources
  from public.sources
  where instagram_account_id = p_account_id and removed_at is null;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', candidate.candidate_key,
    'handle', candidate.handle,
    'profileUrl', candidate.profile_url,
    'normalizedHandle', candidate.normalized_handle,
    'sourceIds', coalesce((
      select jsonb_agg(source.source_key order by source.source_key)
      from public.candidate_sources provenance
      join public.sources source on source.id = provenance.source_id
      where provenance.candidate_id = candidate.id
    ), '[]'::jsonb),
    'status', candidate.status,
    'createdAt', public.followup_iso(candidate.created_at),
    'updatedAt', public.followup_iso(candidate.updated_at),
    'followedAt', public.followup_iso(candidate.followed_at),
    'lastFollowBackCheckAt', public.followup_iso(candidate.last_follow_back_check_at),
    'followBackStatus', candidate.follow_back_status,
    'followBackAt', public.followup_iso(candidate.follow_back_at),
    'followBackReviewDueAt', public.followup_iso(candidate.follow_back_review_due_at),
    'unfollowDueAt', public.followup_iso(candidate.unfollow_due_at),
    'unfollowedAt', public.followup_iso(candidate.unfollowed_at),
    'failedAt', public.followup_iso(candidate.failed_at),
    'nextAction', candidate.next_action
  )) order by candidate.created_at, candidate.id), '[]'::jsonb)
  into v_candidates
  from public.candidates candidate
  where candidate.instagram_account_id = p_account_id;

  select coalesce(jsonb_agg(proof order by created_at, id), '[]'::jsonb)
  into v_history
  from public.action_history
  where instagram_account_id = p_account_id;

  v_state := jsonb_build_object(
    'version', 1,
    'automationEnabled', v_run.automation_enabled,
    'settings', coalesce(v_settings, '{}'::jsonb),
    'sources', v_sources,
    'candidates', v_candidates,
    'run', jsonb_build_object(
      'phase', v_run.phase,
      'activeBatch', coalesce(v_run.run_data->'activeBatch', 'null'::jsonb)
    ) || jsonb_strip_nulls(jsonb_build_object(
      'nextWorkAt', public.followup_iso(v_run.next_work_at),
      'nextSourceScanAt', public.followup_iso(v_run.next_source_scan_at),
      'nextRelationshipReviewAt', public.followup_iso(v_run.next_relationship_review_at),
      'sourceScanSourceId', v_run.source_scan_source_id,
      'lease', v_run.run_data->'lease',
      'safetyDeadlineAt', v_run.run_data->'safetyDeadlineAt',
      'inflightAction', v_run.run_data->'inflightAction',
      'externalOperation', v_run.run_data->'externalOperation'
    )),
    'history', v_history
  );
  return jsonb_build_object('revision', v_run.revision, 'state', v_state);
end;
$$;

create or replace function public.followup_compare_and_swap_state(
  p_account_id uuid, p_revision bigint, p_state jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_run public.automation_runs;
begin
  if jsonb_typeof(p_state) <> 'object' then raise exception 'Follow-up state must be an object.'; end if;
  select * into v_run
  from public.automation_runs
  where instagram_account_id = p_account_id
  for update;
  if v_run.instagram_account_id is null then raise exception 'Instagram account is not provisioned.'; end if;
  if v_run.revision <> p_revision then
    raise exception 'Follow-up state revision conflict.' using errcode = '40001';
  end if;

  insert into public.automation_settings (instagram_account_id, data)
  values (p_account_id, coalesce(p_state->'settings', '{}'::jsonb))
  on conflict (instagram_account_id) do update
  set data = excluded.data,
      revision = public.automation_settings.revision + 1;

  update public.sources source
  set removed_at = now()
  where source.instagram_account_id = p_account_id
    and source.removed_at is null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_state->'sources', '[]'::jsonb)) item
      where item->>'id' = source.source_key
    );

  insert into public.sources (
    instagram_account_id, source_key, profile_url, normalized_handle, status,
    source_limit, collection_depth, warning, created_at, updated_at, last_collected_at, removed_at
  )
  select
    p_account_id,
    item->>'id',
    item->>'profileUrl',
    lower(regexp_replace(item->>'id', '^instagram-source:', '')),
    coalesce(item->>'status', 'pending'),
    coalesce(nullif(item->>'limit', '')::integer, 200),
    coalesce(nullif(item->>'collectionDepth', '')::integer, 0),
    nullif(item->>'warning', ''),
    coalesce(nullif(item->>'createdAt', '')::timestamptz, now()),
    coalesce(nullif(item->>'updatedAt', '')::timestamptz, now()),
    nullif(item->>'lastCollectedAt', '')::timestamptz,
    null
  from jsonb_array_elements(coalesce(p_state->'sources', '[]'::jsonb)) item
  where item->>'id' is not null and item->>'profileUrl' is not null
  on conflict (instagram_account_id, source_key) do update
  set profile_url = excluded.profile_url,
      normalized_handle = excluded.normalized_handle,
      status = excluded.status,
      source_limit = excluded.source_limit,
      collection_depth = excluded.collection_depth,
      warning = excluded.warning,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      last_collected_at = excluded.last_collected_at,
      removed_at = null;

  delete from public.candidates candidate
  where candidate.instagram_account_id = p_account_id
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(p_state->'candidates', '[]'::jsonb)) item
      where item->>'id' = candidate.candidate_key
    );

  insert into public.candidates (
    instagram_account_id, candidate_key, handle, profile_url, normalized_handle,
    status, follow_back_status, created_at, updated_at, followed_at,
    last_follow_back_check_at, follow_back_at, follow_back_review_due_at,
    unfollow_due_at, unfollowed_at, failed_at, next_action
  )
  select
    p_account_id,
    item->>'id',
    item->>'handle',
    item->>'profileUrl',
    lower(coalesce(item->>'normalizedHandle', item->>'handle')),
    item->>'status',
    nullif(item->>'followBackStatus', ''),
    coalesce(nullif(item->>'createdAt', '')::timestamptz, now()),
    coalesce(nullif(item->>'updatedAt', '')::timestamptz, now()),
    nullif(item->>'followedAt', '')::timestamptz,
    nullif(item->>'lastFollowBackCheckAt', '')::timestamptz,
    nullif(item->>'followBackAt', '')::timestamptz,
    nullif(item->>'followBackReviewDueAt', '')::timestamptz,
    nullif(item->>'unfollowDueAt', '')::timestamptz,
    nullif(item->>'unfollowedAt', '')::timestamptz,
    nullif(item->>'failedAt', '')::timestamptz,
    nullif(item->>'nextAction', '')
  from jsonb_array_elements(coalesce(p_state->'candidates', '[]'::jsonb)) item
  where item->>'id' is not null
    and item->>'handle' is not null
    and item->>'profileUrl' is not null
    and item->>'status' is not null
  on conflict (instagram_account_id, normalized_handle) do update
  set candidate_key = excluded.candidate_key,
      handle = excluded.handle,
      profile_url = excluded.profile_url,
      status = excluded.status,
      follow_back_status = excluded.follow_back_status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      followed_at = excluded.followed_at,
      last_follow_back_check_at = excluded.last_follow_back_check_at,
      follow_back_at = excluded.follow_back_at,
      follow_back_review_due_at = excluded.follow_back_review_due_at,
      unfollow_due_at = excluded.unfollow_due_at,
      unfollowed_at = excluded.unfollowed_at,
      failed_at = excluded.failed_at,
      next_action = excluded.next_action;

  delete from public.candidate_sources provenance
  using public.candidates candidate
  where provenance.candidate_id = candidate.id
    and candidate.instagram_account_id = p_account_id;

  insert into public.candidate_sources (candidate_id, source_id)
  select candidate.id, source.id
  from jsonb_array_elements(coalesce(p_state->'candidates', '[]'::jsonb)) candidate_item
  cross join lateral jsonb_array_elements_text(coalesce(candidate_item->'sourceIds', '[]'::jsonb)) source_key(value)
  join public.candidates candidate
    on candidate.instagram_account_id = p_account_id
   and candidate.candidate_key = candidate_item->>'id'
  join public.sources source
    on source.instagram_account_id = p_account_id
   and source.source_key = source_key.value
  on conflict do nothing;

  if jsonb_array_length(coalesce(p_state->'history', '[]'::jsonb)) = 0 then
    delete from public.action_history where instagram_account_id = p_account_id;
  else
    insert into public.action_history (
      instagram_account_id, candidate_id, action, outcome, reason, proof, event_key, created_at
    )
    select
      p_account_id,
      candidate.id,
      coalesce(item->>'action', item->>'kind', 'unknown'),
      coalesce(item->>'status', 'unknown'),
      nullif(item->>'reason', ''),
      item,
      md5(item::text),
      coalesce(nullif(item->>'timestamp', '')::timestamptz, nullif(item->>'at', '')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_state->'history', '[]'::jsonb)) item
    left join public.candidates candidate
      on candidate.instagram_account_id = p_account_id
     and candidate.candidate_key = item->>'candidateId'
    on conflict (instagram_account_id, event_key) do nothing;
  end if;

  update public.automation_runs
  set automation_enabled = coalesce((p_state->>'automationEnabled')::boolean, false),
      phase = coalesce(p_state->'run'->>'phase', 'idle'),
      next_work_at = nullif(p_state->'run'->>'nextWorkAt', '')::timestamptz,
      next_source_scan_at = nullif(p_state->'run'->>'nextSourceScanAt', '')::timestamptz,
      next_relationship_review_at = nullif(p_state->'run'->>'nextRelationshipReviewAt', '')::timestamptz,
      source_scan_source_id = nullif(p_state->'run'->>'sourceScanSourceId', ''),
      run_data = jsonb_strip_nulls(jsonb_build_object(
        'activeBatch', p_state->'run'->'activeBatch',
        'lease', p_state->'run'->'lease',
        'safetyDeadlineAt', p_state->'run'->'safetyDeadlineAt',
        'inflightAction', p_state->'run'->'inflightAction',
        'externalOperation', p_state->'run'->'externalOperation'
      )),
      revision = revision + 1
  where instagram_account_id = p_account_id;

  return public.followup_read_state(p_account_id);
end;
$$;

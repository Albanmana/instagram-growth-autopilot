-- The relational projection is authoritative, but bounded live-test ownership is
-- scheduler state rather than a candidate/source column. Keep it in run_data so
-- a compare-and-swap round trip cannot widen a live test to historical leads.

alter function public.followup_read_state(uuid)
  rename to followup_read_state_base;

alter function public.followup_compare_and_swap_state(uuid, bigint, jsonb)
  rename to followup_compare_and_swap_state_base;

create function public.followup_read_state(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
  v_run_data jsonb;
begin
  v_result := public.followup_read_state_base(p_account_id);
  select run_data into v_run_data
  from public.automation_runs
  where instagram_account_id = p_account_id;

  return jsonb_set(
    v_result,
    '{state,run}',
    (v_result #> '{state,run}') || jsonb_strip_nulls(jsonb_build_object(
      'liveTestSourceId', v_run_data->'liveTestSourceId',
      'liveTestCandidateIds', v_run_data->'liveTestCandidateIds'
    ))
  );
end;
$$;

create function public.followup_compare_and_swap_state(
  p_account_id uuid, p_revision bigint, p_state jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.followup_compare_and_swap_state_base(p_account_id, p_revision, p_state);

  update public.automation_runs
  set run_data = (run_data - 'liveTestSourceId' - 'liveTestCandidateIds') || jsonb_strip_nulls(jsonb_build_object(
    'liveTestSourceId', p_state->'run'->'liveTestSourceId',
    'liveTestCandidateIds', p_state->'run'->'liveTestCandidateIds'
  ))
  where instagram_account_id = p_account_id;

  return public.followup_read_state(p_account_id);
end;
$$;

-- The global balanced-cycle deadline is scheduler state. The relational
-- projection owns candidates and sources, but must round-trip this run_data
-- field so a service-worker restart does not erase the calendar plan.

alter function public.followup_read_state(uuid)
  rename to followup_read_state_live_test_base;

alter function public.followup_compare_and_swap_state(uuid, bigint, jsonb)
  rename to followup_compare_and_swap_state_live_test_base;

create function public.followup_read_state(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
  v_run_data jsonb;
begin
  v_result := public.followup_read_state_live_test_base(p_account_id);
  select run_data into v_run_data
  from public.automation_runs
  where instagram_account_id = p_account_id;

  return jsonb_set(
    v_result,
    '{state,run}',
    (v_result #> '{state,run}') || jsonb_strip_nulls(jsonb_build_object(
      'cycle', v_run_data->'cycle'
    ))
  );
end;
$$;

create function public.followup_compare_and_swap_state(
  p_account_id uuid, p_revision bigint, p_state jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.followup_compare_and_swap_state_live_test_base(p_account_id, p_revision, p_state);

  update public.automation_runs
  set run_data = (run_data - 'cycle') || jsonb_strip_nulls(jsonb_build_object(
    'cycle', p_state->'run'->'cycle'
  ))
  where instagram_account_id = p_account_id;

  return public.followup_read_state(p_account_id);
end;
$$;

alter table public.automation_runs
  add column state jsonb not null default jsonb_build_object(
    'version', 1,
    'automationEnabled', false,
    'settings', '{}'::jsonb,
    'sources', '[]'::jsonb,
    'candidates', '[]'::jsonb,
    'run', jsonb_build_object('phase', 'idle', 'activeBatch', null),
    'history', '[]'::jsonb
  );

create or replace function public.followup_read_state(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  select jsonb_build_object('revision', revision, 'state', state) into result
  from public.automation_runs where instagram_account_id = p_account_id;
  if result is null then raise exception 'Instagram account is not provisioned.'; end if;
  return result;
end;
$$;

create or replace function public.followup_compare_and_swap_state(
  p_account_id uuid, p_revision bigint, p_state jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare result public.automation_runs;
begin
  update public.automation_runs
  set state = p_state, revision = revision + 1
  where instagram_account_id = p_account_id and revision = p_revision
  returning * into result;
  if result.instagram_account_id is null then raise exception 'Follow-up state revision conflict.' using errcode = '40001'; end if;
  return jsonb_build_object('revision', result.revision, 'state', result.state);
end;
$$;

create or replace function public.followup_claim_next_task(
  p_account_id uuid,
  p_claim_owner text
) returns public.browser_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.browser_tasks;
begin
  update public.browser_tasks
  set status = 'requires_confirmation', updated_at = now()
  where instagram_account_id = p_account_id
    and status = 'started'
    and expires_at is not null
    and expires_at <= now();

  select * into claimed
  from public.browser_tasks
  where instagram_account_id = p_account_id
    and status = 'queued'
  order by created_at
  for update skip locked
  limit 1;

  if claimed.id is null then return null; end if;

  update public.browser_tasks
  set status = 'claimed',
      claim_owner = p_claim_owner,
      claim_token = encode(gen_random_bytes(24), 'hex'),
      claimed_at = now(),
      expires_at = now() + interval '15 minutes'
  where id = claimed.id
  returning * into claimed;

  return claimed;
end;
$$;

create or replace function public.followup_start_task(
  p_account_id uuid,
  p_task_id uuid,
  p_claim_token text
) returns public.browser_tasks
language plpgsql
security definer
set search_path = public
as $$
declare started public.browser_tasks;
begin
  update public.browser_tasks
  set status = 'started', started_at = now(), expires_at = now() + interval '30 minutes'
  where id = p_task_id
    and instagram_account_id = p_account_id
    and status = 'claimed'
    and claim_token = p_claim_token
  returning * into started;
  if started.id is null then raise exception 'Task claim does not match.'; end if;
  return started;
end;
$$;

create or replace function public.followup_complete_task(
  p_account_id uuid,
  p_task_id uuid,
  p_claim_token text,
  p_outcome jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare task public.browser_tasks;
begin
  update public.browser_tasks
  set status = case when coalesce(p_outcome->>'status', '') in ('succeeded', 'follow_request_sent', 'skipped') then 'completed' else 'failed' end,
      result = p_outcome,
      completed_at = now(),
      expires_at = null
  where id = p_task_id
    and instagram_account_id = p_account_id
    and status in ('claimed', 'started')
    and claim_token = p_claim_token
  returning * into task;
  if task.id is null then raise exception 'Task claim does not match.'; end if;

  insert into public.action_history (instagram_account_id, browser_task_id, action, outcome, reason, proof)
  values (p_account_id, task.id, task.kind::text, coalesce(p_outcome->>'status', 'failed'), p_outcome->>'reason', p_outcome);

  return jsonb_build_object('ok', true, 'taskId', task.id, 'status', task.status);
end;
$$;

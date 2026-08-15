create or replace function public.followup_provision_account(p_handle text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_normalized text := lower(regexp_replace(trim(coalesce(p_handle, '')), '^@', ''));
  account_id uuid;
  created boolean := false;
begin
  if v_normalized !~ '^[a-z0-9._]{1,30}$' then
    raise exception 'A valid Instagram handle is required.';
  end if;

  insert into public.instagram_accounts (normalized_handle)
  values (v_normalized)
  on conflict (normalized_handle) do nothing
  returning id into account_id;
  created := account_id is not null;

  if account_id is null then
    select id into account_id from public.instagram_accounts where normalized_handle = v_normalized;
  end if;

  insert into public.automation_settings (instagram_account_id) values (account_id)
  on conflict (instagram_account_id) do nothing;
  insert into public.automation_runs (instagram_account_id) values (account_id)
  on conflict (instagram_account_id) do nothing;

  return jsonb_build_object('accountId', account_id, 'normalizedHandle', v_normalized, 'created', created);
end;
$$;

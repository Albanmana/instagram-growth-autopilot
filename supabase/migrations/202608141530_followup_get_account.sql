create or replace function public.followup_get_account(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_handle text;
begin
  select normalized_handle into v_handle
  from public.instagram_accounts
  where id = p_account_id;

  if v_handle is null then
    raise exception 'Instagram account was not found.';
  end if;

  return jsonb_build_object('normalizedHandle', v_handle);
end;
$$;

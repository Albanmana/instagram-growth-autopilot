create extension if not exists pgcrypto;

create type public.followup_task_status as enum (
  'queued', 'claimed', 'started', 'requires_confirmation', 'completed', 'failed', 'cancelled'
);

create type public.followup_task_kind as enum (
  'source_collection', 'relationship_review', 'follow', 'unfollow'
);

create table public.instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  normalized_handle text not null unique check (normalized_handle = lower(normalized_handle)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.automation_settings (
  instagram_account_id uuid primary key references public.instagram_accounts(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table public.automation_runs (
  instagram_account_id uuid primary key references public.instagram_accounts(id) on delete cascade,
  automation_enabled boolean not null default false,
  phase text not null default 'idle',
  next_work_at timestamptz,
  next_source_scan_at timestamptz,
  next_relationship_review_at timestamptz,
  source_scan_source_id text,
  external_operation jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  instagram_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  source_key text not null,
  profile_url text not null,
  normalized_handle text not null check (normalized_handle = lower(normalized_handle)),
  status text not null default 'pending',
  source_limit integer not null check (source_limit > 0),
  collection_depth integer not null default 0 check (collection_depth >= 0),
  warning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_collected_at timestamptz,
  unique (instagram_account_id, normalized_handle),
  unique (instagram_account_id, source_key)
);

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  instagram_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  handle text not null,
  profile_url text not null,
  normalized_handle text not null check (normalized_handle = lower(normalized_handle)),
  status text not null,
  follow_back_status text check (follow_back_status in ('unknown', 'confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  followed_at timestamptz,
  follow_request_sent_at timestamptz,
  last_follow_back_check_at timestamptz,
  follow_back_at timestamptz,
  follow_back_review_due_at timestamptz,
  unfollow_due_at timestamptz,
  unfollowed_at timestamptz,
  failed_at timestamptz,
  next_action text,
  unique (instagram_account_id, normalized_handle)
);

create table public.candidate_sources (
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (candidate_id, source_id)
);

create table public.browser_tasks (
  id uuid primary key default gen_random_uuid(),
  instagram_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  idempotency_key text not null,
  kind public.followup_task_kind not null,
  payload jsonb not null default '{}'::jsonb,
  status public.followup_task_status not null default 'queued',
  claim_owner text,
  claim_token text,
  claimed_at timestamptz,
  started_at timestamptz,
  expires_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (instagram_account_id, idempotency_key),
  check ((status not in ('claimed', 'started') and claim_token is null) or claim_token is not null)
);

create unique index browser_tasks_single_active_account
  on public.browser_tasks (instagram_account_id)
  where status in ('claimed', 'started', 'requires_confirmation');

create table public.action_history (
  id uuid primary key default gen_random_uuid(),
  instagram_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  browser_task_id uuid references public.browser_tasks(id) on delete set null,
  candidate_id uuid references public.candidates(id) on delete set null,
  action text not null,
  outcome text not null,
  reason text,
  proof jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.legacy_imports (
  id uuid primary key default gen_random_uuid(),
  instagram_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  checksum text not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  unique (instagram_account_id, checksum)
);

create or replace function public.touch_followup_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger touch_instagram_accounts before update on public.instagram_accounts
for each row execute procedure public.touch_followup_updated_at();
create trigger touch_automation_settings before update on public.automation_settings
for each row execute procedure public.touch_followup_updated_at();
create trigger touch_automation_runs before update on public.automation_runs
for each row execute procedure public.touch_followup_updated_at();
create trigger touch_sources before update on public.sources
for each row execute procedure public.touch_followup_updated_at();
create trigger touch_candidates before update on public.candidates
for each row execute procedure public.touch_followup_updated_at();
create trigger touch_browser_tasks before update on public.browser_tasks
for each row execute procedure public.touch_followup_updated_at();

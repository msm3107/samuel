-- Verification checks (TASK-022): append-only evidence that a deployment
-- was checked (README §5, §18-§20; PLAN Phase 7).
--
-- Nothing writes this table yet. TASK-023 fetches, TASK-024 inspects,
-- TASK-025 schedules. The schema lands first because a migration adding
-- something the application reads ships before the code that reads it.
--
-- Who can do what:
--   * Only the service role inserts. Evidence is produced by the scheduled
--     job, not by a user; a member who could insert could manufacture their
--     own compliance history, so `authenticated` has no insert grant and
--     there is no insert policy.
--   * Nobody updates a row, the service role included: no role has the
--     grant, and a trigger refuses it even for the table owner.
--   * Nobody deletes a single row the same way. In practice the
--     organization is the only door: a deployment and an AI system are
--     each archived rather than deleted, and their history is kept
--     (README §33). The trigger below still admits a deployment or a
--     disclosure that is already gone, because a cascade visits rows in no
--     promised order.
--   * Every member of a live organization reads its own checks, viewers
--     included: evidence is the thing customers rely on.
--
-- As for audit_events, this protects history from the application, its
-- users and the service-role key. It is not tamper-proof against database-
-- owner access, which can disable a trigger or set
-- `session_replication_role = replica`. That is what §20's hash chain is
-- for, and why its columns are created here (below) rather than added to a
-- table customers already rely on.
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-26:
--   * `status` says success or failure; `failure_code` carries the reason
--     and is null exactly when the status is success. `SUCCESS` is not
--     stored as a code — `status` already says it, and a second encoding of
--     one fact is a second thing that can be wrong. §19's example list
--     therefore has one entry this constraint does not.
--   * Idempotency is the database's: `unique (deployment_id, check_window)`.
--     A cron that fires twice, or overlaps itself, cannot write two rows for
--     one window. Rejected: a read-then-write check in the route, where two
--     overlapping runs both read "none" and both write — into a table
--     nothing can later clean up.
--   * A deployment with nothing to show is not checked, so `disclosure_id`
--     is `not null`: there is no notice to look for, and every row names the
--     exact version it was checked against.
--   * `metadata` holds facts about the check, never content from the
--     customer's page. A page can contain anything, including personal data
--     of the customer's own visitors (README §34).

create table public.verification_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  deployment_id uuid not null,
  -- The version the check expected to find, never null: a deployment whose
  -- system has published nothing, or whose notice is turned off, is not
  -- checked at all (owner, 2026-09-26).
  disclosure_id uuid not null,
  status text not null
    constraint verification_checks_status_check
      check (status in ('success', 'failure')),
  -- README §19, less SUCCESS. Text with a check constraint rather than an
  -- enum, as deployments.status and ai_systems.status are: adding a code is
  -- then one migration rather than a type alteration, and the list reads
  -- here. TOTAL_TIMEOUT and TOO_MANY_REDIRECTS are not in §19's example
  -- list; Phase 7 requires each exceeded bound to map to its own code, and
  -- §19 is amended to match.
  failure_code text
    constraint verification_checks_failure_code_check check (
      failure_code in (
        'DNS_ERROR',
        'CONNECTION_TIMEOUT',
        'TOTAL_TIMEOUT',
        'HTTP_ERROR',
        'REDIRECT_BLOCKED',
        'TOO_MANY_REDIRECTS',
        'PRIVATE_NETWORK_BLOCKED',
        'RESPONSE_TOO_LARGE',
        'WIDGET_NOT_FOUND',
        'DEPLOYMENT_ID_MISMATCH',
        'DISCLOSURE_VERSION_MISMATCH',
        'UNKNOWN_ERROR'
      )
    ),
  -- The two columns cannot disagree: a success carries no reason, and a
  -- failure always carries one.
  constraint verification_checks_failure_code_matches_status_check
    check ((status = 'success') = (failure_code is null)),
  -- The database's clock, set by the trigger below. A job's clock is not
  -- evidence.
  checked_at timestamptz not null default now(),
  -- The start of the window this check belongs to. The writer's, because it
  -- is the schedule's fact rather than an observation — and the unique key
  -- below is what makes the job idempotent. The window a check belongs to
  -- cannot begin after the check happened.
  check_window timestamptz not null
    constraint verification_checks_check_window_check
      check (check_window <= checked_at),
  -- Null when no response arrived at all: a check that failed at DNS has no
  -- status to report, and a row that said 0 would be false evidence.
  http_status integer
    constraint verification_checks_http_status_check
      check (http_status between 100 and 599),
  -- Null when no body was inspected.
  widget_detected boolean,
  -- The version observed **on the page**, not the one expected — the
  -- expected one is what disclosure_id names. Null when nothing was found
  -- to read a version from. This pair is what DISCLOSURE_VERSION_MISMATCH
  -- is about.
  disclosure_version integer
    constraint verification_checks_disclosure_version_check
      check (disclosure_version >= 1),
  -- Facts about the check: redirect chain length, response size, timings,
  -- which matcher failed. Never bytes from the customer's page (owner,
  -- 2026-09-26). Bounded in shape and size so nothing large or
  -- unstructured can land here, as for audit_events.
  metadata jsonb not null default '{}'::jsonb
    constraint verification_checks_metadata_object_check
      check (jsonb_typeof(metadata) = 'object')
    constraint verification_checks_metadata_size_check
      check (octet_length(metadata::text) <= 2048),
  -- README §20's chain, reserved and unpopulated. Not required for launch;
  -- created now because adding them later means a migration across evidence
  -- rows customers are already relying on (PLAN Phase 7). A digest is 64
  -- lowercase hex characters if it is anything at all.
  payload_hash text
    constraint verification_checks_payload_hash_check
      check (payload_hash ~ '^[0-9a-f]{64}$'),
  previous_record_hash text
    constraint verification_checks_previous_record_hash_check
      check (previous_record_hash ~ '^[0-9a-f]{64}$'),
  -- The deployment is in the same organization as the check: the composite
  -- key TASK-011 left on deployments for exactly this.
  constraint verification_checks_deployment_fkey
    foreign key (organization_id, deployment_id)
    references public.deployments (organization_id, id) on delete cascade,
  -- And so is the disclosure: the key TASK-016 left for it. A row naming
  -- one organization's deployment and another's disclosure is refused by
  -- the database, not by a code path.
  constraint verification_checks_disclosure_fkey
    foreign key (organization_id, disclosure_id)
    references public.disclosures (organization_id, id) on delete cascade,
  -- One check per deployment per window. The second write of a window loses
  -- here rather than in the route (owner, 2026-09-26).
  constraint verification_checks_deployment_id_check_window_key
    unique (deployment_id, check_window)
);

-- A deployment's history, newest first (Phase 8), and the lookup the
-- cascade from deployments uses: deployment_id leads, so a cascade filters
-- the organization from rows it has already narrowed.
create index verification_checks_deployment_id_checked_at_idx
  on public.verification_checks (deployment_id, checked_at desc);

-- An organization's history, newest first (Phase 8, Phase 9's reports).
create index verification_checks_organization_id_checked_at_idx
  on public.verification_checks (organization_id, checked_at desc);

-- The lookup the cascade from disclosures uses. The index above leads with
-- the organization and then the time, so without this one a deleted AI
-- system would scan every check the organization ever collected.
create index verification_checks_organization_id_disclosure_id_idx
  on public.verification_checks (organization_id, disclosure_id);

alter table public.verification_checks enable row level security;

comment on table public.verification_checks is
  'Append-only evidence that a deployment was checked. Never updated; rows go only when their organization is deleted, since a deployment and an AI system are archived rather than deleted.';

comment on column public.verification_checks.metadata is
  'Facts about the check only — redirect count, response size, timings, which matcher failed. Never content fetched from the customer''s page (README §34).';

comment on column public.verification_checks.disclosure_version is
  'The version observed on the page, not the one expected; disclosure_id names the expected one.';

-- The time is the database's, whatever the writer sends. Constraints are
-- evaluated after this runs, so check_window is compared against the real
-- time of the check.
create function private.set_verification_check_checked_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.checked_at := now();
  return new;
end;
$$;

revoke all on function private.set_verification_check_checked_at()
  from public, anon, authenticated;

create trigger verification_checks_set_checked_at
  before insert on public.verification_checks
  for each row execute function private.set_verification_check_checked_at();

-- Append-only, for every role, the table owner included (short of disabling
-- the trigger). The one delete allowed is a cascade: it runs inside the
-- foreign key's own trigger, so `pg_trigger_depth()` is above 1, and by
-- then the parent row is gone. Both are required — depth alone would also
-- admit a delete issued by any other trigger. Three parents can cascade
-- here, and an AI system's deletion arrives through the last two.
create function private.refuse_verification_check_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and pg_trigger_depth() > 1
    and (
      not exists (
        select 1 from public.organizations where id = old.organization_id
      )
      or not exists (
        select 1 from public.deployments
        where organization_id = old.organization_id
          and id = old.deployment_id
      )
      or not exists (
        select 1 from public.disclosures
        where organization_id = old.organization_id
          and id = old.disclosure_id
      )
    ) then
    return old;
  end if;
  raise exception 'verification checks are append-only'
    using errcode = '42501';
end;
$$;

revoke all on function private.refuse_verification_check_change()
  from public, anon, authenticated;

create trigger verification_checks_append_only
  before update or delete on public.verification_checks
  for each row execute function private.refuse_verification_check_change();

create trigger verification_checks_no_truncate
  before truncate on public.verification_checks
  for each statement execute function private.refuse_verification_check_change();

-- Grants. Start from nothing, as for audit_events. No insert for a user:
-- a member who could insert could manufacture their own evidence.
revoke all on table public.verification_checks
  from anon, authenticated, service_role;

grant select on table public.verification_checks to authenticated;
grant select, insert on table public.verification_checks to service_role;

-- Every member of a live organization reads its checks, viewers included.
create policy verification_checks_select_member
  on public.verification_checks
  for select
  to authenticated
  using (
    authz.has_org_role(
      organization_id,
      array['owner', 'admin', 'member', 'viewer']
    )
  );

-- Audit events (TASK-006): an append-only record of security-sensitive
-- business actions (README §6).
--
-- Who can do what:
--   * Nobody updates a row through the API, the service role included: no
--     role has the grant, and a trigger refuses it even for the table owner.
--   * Nobody deletes a single row the same way. Rows go only with their
--     organization, when the organization row itself is deleted, which only
--     the service role can do (README §33: organizations are soft deleted; a
--     hard delete is a deliberate retention step).
--   * Only the service role inserts. A user inserting through the Data API
--     could forge history, so `authenticated` has no insert grant; the
--     application validates each event and writes it server-side.
--   * Owners and admins read their own organization's events.
--
-- This protects history from the application, its users and the service-role
-- key. It is not tamper-proof against someone with database-owner access,
-- who can disable the trigger or skip it with
-- `session_replication_role = replica`. Tamper evidence (hash-chained rows,
-- or a copy in external storage) is a Phase 12 question.

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  -- No foreign key: the history must outlive the user. A key would either
  -- block deleting the user, delete their history, or rewrite it to null.
  actor_user_id uuid not null,
  -- Extended by migration, never by a free-form string at a call site.
  event_type text not null
    constraint audit_events_event_type_check check (
      event_type in (
        'organization.created',
        'member.added',
        'member.invited',
        'member.role_changed',
        'member.removed',
        'ai_system.created',
        'deployment.created',
        'disclosure.published',
        'report.generated',
        'billing.plan_changed'
      )
    ),
  entity_type text not null
    constraint audit_events_entity_type_check check (
      entity_type in (
        'organization',
        'membership',
        'invitation',
        'ai_system',
        'deployment',
        'disclosure',
        'report'
      )
    ),
  entity_id uuid not null,
  -- Validated per event type by the application; the database bounds its
  -- shape and size so nothing large or unstructured can land here.
  metadata jsonb not null default '{}'::jsonb
    constraint audit_events_metadata_object_check check (
      jsonb_typeof(metadata) = 'object'
    )
    constraint audit_events_metadata_size_check check (
      octet_length(metadata::text) <= 2048
    ),
  created_at timestamptz not null default now()
);

create index audit_events_organization_created_at_idx
  on public.audit_events (organization_id, created_at desc);

alter table public.audit_events enable row level security;

-- The time is the database's, whatever the writer sends.
create function private.set_audit_event_created_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

revoke all on function private.set_audit_event_created_at()
  from public, anon, authenticated;

create trigger audit_events_set_created_at
  before insert on public.audit_events
  for each row execute function private.set_audit_event_created_at();

-- Append-only, for every role, the table owner included (short of disabling
-- the trigger). The one delete allowed is the cascade from deleting the
-- organization. It runs inside the foreign key's own trigger, so
-- `pg_trigger_depth()` is above 1, and by then the organization row is gone.
-- Both are required: depth alone would also admit a delete issued by any
-- other trigger.
create function private.refuse_audit_event_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and pg_trigger_depth() > 1
    and not exists (
      select 1 from public.organizations where id = old.organization_id
    ) then
    return old;
  end if;
  raise exception 'audit events are append-only'
    using errcode = '42501';
end;
$$;

revoke all on function private.refuse_audit_event_change()
  from public, anon, authenticated;

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function private.refuse_audit_event_change();

create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function private.refuse_audit_event_change();

-- Grants. Start from nothing, as for organizations and memberships.
revoke all on table public.audit_events from anon, authenticated, service_role;

grant select on table public.audit_events to authenticated;
grant select, insert on table public.audit_events to service_role;

create policy audit_events_select_owner_or_admin
  on public.audit_events
  for select
  to authenticated
  using (authz.has_org_role(organization_id, array['owner', 'admin']));

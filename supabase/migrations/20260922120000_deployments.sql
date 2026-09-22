-- Deployments (TASK-011): where an organization's AI system is publicly
-- deployed, by hostname (README §5).
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-22:
--   * A hostname is unique per AI system among active deployments. Two
--     systems can share a site, and two organizations can both name one; the
--     verifier (Phase 7) proves who has the widget there. Unique across all
--     customers was rejected: anyone could squat a real owner's site, and
--     "taken" would tell a stranger another customer uses it.
--   * A deployment's hostname and AI system are fixed once it is created.
--     To change either, archive it and register again, so verification
--     history always means the same site and system.
--   * A deployment cannot be created or restored under an archived AI system.
--     Archiving a system leaves its deployments as they are.
--
-- Proposed by the implementer, awaiting the owner:
--   * The database checks a hostname's shape, not its safety. Loopback,
--     private and metadata names are refused by lib/security (TASK-012) and
--     again when the verifier resolves them (Phase 7). The shape check still
--     refuses every IP literal and every single-label name, `localhost`
--     included, because it demands a dot and a top-level label with a letter.
--   * Status is `active | archived`, as for AI systems. Users archive; only
--     the service role deletes (README §33: archive a deployment, keep its
--     verification history).
--   * Creation, archive and restore are audited by trigger, as for AI
--     systems.
--   * The public deployment identifier is TASK-014's column, not this one.

create table public.deployments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  ai_system_id uuid not null,
  -- A normalized hostname: lowercase ASCII, IDN labels already
  -- punycode-encoded, no trailing dot, no port. Labels of 1 to 63 letters,
  -- digits and inner hyphens; at least two of them; the last with a letter
  -- (the second pattern), which rules out 127.0.0.1, 0x7f.1 and every other
  -- IP literal. IPv6 and ports need a colon, which no label allows.
  hostname text not null
    constraint deployments_hostname_check check (
      char_length(hostname) <= 253
      and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
      and hostname ~ '[a-z][a-z0-9-]*$'
    ),
  status text not null default 'active'
    constraint deployments_status_check check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The system is in the same organization as the deployment: the composite
  -- key TASK-008 left on ai_systems for exactly this.
  constraint deployments_ai_system_fkey
    foreign key (organization_id, ai_system_id)
    references public.ai_systems (organization_id, id) on delete cascade,
  -- The target of verification_checks' composite foreign key (Phase 7), and
  -- the index for deployments by organization.
  constraint deployments_organization_id_id_key unique (organization_id, id)
);

-- One active deployment per system and hostname. Hostnames are stored
-- lowercase, so no lower() is needed. The index decides, so two concurrent
-- registrations cannot both pass.
create unique index deployments_active_hostname_key
  on public.deployments (ai_system_id, hostname)
  where status = 'active';

-- Deployments by system, and the lookup the cascade from ai_systems uses.
create index deployments_organization_id_ai_system_id_idx
  on public.deployments (organization_id, ai_system_id);

alter table public.deployments enable row level security;

comment on table public.deployments is
  'Where an AI system is publicly deployed, by hostname. Archived rather than deleted.';

-- Timestamps are the database's, as for ai_systems.
create function private.set_deployment_created_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_deployment_created_at()
  from public, anon, authenticated;

create trigger deployments_set_created_at
  before insert on public.deployments
  for each row execute function private.set_deployment_created_at();

create trigger deployments_set_updated_at
  before update on public.deployments
  for each row execute function private.set_updated_at();

-- What no writer changes, the service role included: the id, organization,
-- AI system and hostname (owner, 2026-09-22), and created_at. The column
-- grants already stop users; this stops everyone short of the table owner
-- disabling the trigger.
create function private.guard_deployment_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.organization_id <> old.organization_id
    or new.ai_system_id <> old.ai_system_id
    or new.hostname <> old.hostname
  then
    raise exception 'a deployment keeps its id, organization, AI system and hostname'
      using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

revoke all on function private.guard_deployment_update()
  from public, anon, authenticated;

create trigger deployments_guard_update
  before update on public.deployments
  for each row execute function private.guard_deployment_update();

-- No active deployment under an archived AI system (owner, 2026-09-22).
--
-- After the row is written, so RLS has already refused a caller outside the
-- organization and this never reports on someone else's system. It runs as
-- the caller: a member can read the system and lock it, and a system the
-- caller cannot see counts as not active.
--
-- `for share` makes this and a concurrent archive of the system take turns.
-- If the archive commits first, this reads the archived row and refuses; if
-- this commits first, the archive waits, then goes ahead, and the deployment
-- stays as archiving leaves deployments.
create function private.require_active_ai_system()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform
  from public.ai_systems
  where organization_id = new.organization_id
    and id = new.ai_system_id
    and status = 'active'
  for share;

  if not found then
    raise exception 'a deployment''s AI system is archived'
      using errcode = '23514', constraint = 'deployments_ai_system_active';
  end if;
  return null;
end;
$$;

revoke all on function private.require_active_ai_system()
  from public, anon, authenticated;

create trigger deployments_require_active_ai_system_insert
  after insert on public.deployments
  for each row
  when (new.status = 'active')
  execute function private.require_active_ai_system();

create trigger deployments_require_active_ai_system_restore
  after update of status on public.deployments
  for each row
  when (new.status = 'active' and old.status <> 'active')
  execute function private.require_active_ai_system();

-- Audit. deployment.created is already an event type; archive and restore
-- join it here. features/organizations/audit/audit-events.ts mirrors the
-- list, and a unit test keeps the two in step.
alter table public.audit_events
  drop constraint audit_events_event_type_check,
  add constraint audit_events_event_type_check check (
    event_type in (
      'organization.created',
      'member.added',
      'member.invited',
      'member.role_changed',
      'member.removed',
      'ai_system.created',
      'ai_system.updated',
      'ai_system.archived',
      'ai_system.unarchived',
      'deployment.created',
      'deployment.archived',
      'deployment.unarchived',
      'disclosure.published',
      'report.generated',
      'billing.plan_changed'
    )
  );

-- The audit row for every creation, archive and restore, in the same
-- transaction however it was written. Security definer, because users have
-- no insert grant on audit_events; the actor comes from the JWT, never the
-- row, and no metadata is written: the hostname stays out of the log.
--
--   insert           -> deployment.created
--   status changes   -> deployment.archived / deployment.unarchived
--
-- Nothing else can change (the guard above), so an update that leaves the
-- status alone writes nothing. A write with no signed-in user, the service
-- role's included, is refused, so every event has an actor.
create function private.audit_deployment_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'deployment.created';
  elsif new.status is distinct from old.status then
    v_event := case new.status
      when 'archived' then 'deployment.archived'
      else 'deployment.unarchived'
    end;
  else
    return null;
  end if;

  if v_actor is null then
    raise exception 'deployments are changed by a signed-in user'
      using errcode = '42501';
  end if;

  insert into public.audit_events
    (organization_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values
    (new.organization_id, v_actor, v_event, 'deployment', new.id, '{}'::jsonb);

  return null;
end;
$$;

revoke all on function private.audit_deployment_change()
  from public, anon, authenticated;

create trigger deployments_audit_insert
  after insert on public.deployments
  for each row execute function private.audit_deployment_change();

create trigger deployments_audit_update
  after update on public.deployments
  for each row execute function private.audit_deployment_change();

-- Grants. Start from nothing. A user names the organization, system and
-- hostname on insert and changes only the status afterwards. No delete
-- grant: users archive.
revoke all on table public.deployments from anon, authenticated;

grant select on table public.deployments to authenticated;
grant insert (organization_id, ai_system_id, hostname)
  on table public.deployments to authenticated;
grant update (status) on table public.deployments to authenticated;

-- Every member of a live organization reads its deployments.
create policy deployments_select_member
  on public.deployments
  for select
  to authenticated
  using (
    authz.has_org_role(
      organization_id,
      array['owner', 'admin', 'member', 'viewer']
    )
  );

-- Members and up register and archive (`deployments.manage`).
create policy deployments_insert_member
  on public.deployments
  for insert
  to authenticated
  with check (
    authz.has_org_role(organization_id, array['owner', 'admin', 'member'])
  );

create policy deployments_update_member
  on public.deployments
  for update
  to authenticated
  using (
    authz.has_org_role(organization_id, array['owner', 'admin', 'member'])
  )
  with check (
    authz.has_org_role(organization_id, array['owner', 'admin', 'member'])
  );

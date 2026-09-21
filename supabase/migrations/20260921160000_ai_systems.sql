-- AI systems (TASK-008): the AI systems an organization discloses (README §5).
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-21:
--   * Status is `active` or `archived`. Users archive; they never delete, so
--     the deployments, verification history and reports that will point at a
--     system survive. Only the service role deletes, as for organizations.
--   * `provider` is optional free text.
--   * Names are unique within an organization among active systems, ignoring
--     case. An archived system's name can be reused.
--   * Members and up write (`systems.manage`); viewers read.
--
-- On the PR #22 review, same date:
--   * Every creation, edit, archive and un-archive is audited by a trigger,
--     in the same transaction, however the row was written. A write with no
--     signed-in user (the service role) is refused, so every event has an
--     actor.
--   * Names and providers refuse Unicode format characters (right-to-left
--     overrides, zero-width spaces and the like, but not the zero-width
--     joiner): system names are shown to the public in the widget.
--
-- Unicode format characters (general category Cf) other than U+200D, as of
-- Unicode 16.0. Postgres regular expressions have no \p{Cf}, so the ranges are
-- written out; a unit test compares them with JavaScript's \p{Cf}. The same
-- pattern appears in every check below and in
-- 20260921170000_name_format_characters.sql.

create table public.ai_systems (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  -- Shown in the dashboard, the widget's configuration and reports: one line,
  -- no control or format characters.
  name text not null
    constraint ai_systems_name_check check (
      char_length(name) between 1 and 120
      and name = btrim(name)
      and name !~ '[[:cntrl:]]'
      and name !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'
    ),
  -- Several lines allowed; other control characters are not.
  description text
    constraint ai_systems_description_check check (
      char_length(description) between 1 and 2000
      and description !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
    ),
  system_type text not null
    constraint ai_systems_system_type_check check (
      system_type in ('chatbot', 'voice_agent', 'assistant', 'generator', 'other')
    ),
  -- The vendor behind the system, as the customer names it: "OpenAI",
  -- "in-house". Free text rather than a list that would go stale.
  provider text
    constraint ai_systems_provider_check check (
      char_length(provider) between 1 and 100
      and provider = btrim(provider)
      and provider !~ '[[:cntrl:]]'
      and provider !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'
    ),
  status text not null default 'active'
    constraint ai_systems_status_check check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The target of later composite foreign keys: a deployment or disclosure
  -- naming (organization_id, ai_system_id) cannot belong to one organization
  -- and point at another's system. Also the index for systems by
  -- organization, its leading column.
  constraint ai_systems_organization_id_id_key unique (organization_id, id)
);

-- One active system per name in an organization, whatever the case. The
-- index decides, so two concurrent creations cannot both pass.
create unique index ai_systems_active_name_key
  on public.ai_systems (organization_id, lower(name))
  where status = 'active';

alter table public.ai_systems enable row level security;

comment on table public.ai_systems is
  'An AI system an organization discloses. Archived rather than deleted.';

-- The timestamps are the database's, set by triggers for every writer. The
-- table owner can still disable triggers; nothing here protects against
-- database-owner access (as for audit_events).
create function private.set_ai_system_created_at()
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

revoke all on function private.set_ai_system_created_at()
  from public, anon, authenticated;

create trigger ai_systems_set_created_at
  before insert on public.ai_systems
  for each row execute function private.set_ai_system_created_at();

create trigger ai_systems_set_updated_at
  before update on public.ai_systems
  for each row execute function private.set_updated_at();

-- What no writer changes, the service role included: `created_at` stays, and
-- a system keeps its ID and never moves to another organization. The column
-- grants already stop users; this stops everyone short of the table owner
-- disabling the trigger.
create function private.guard_ai_system_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.organization_id <> old.organization_id then
    raise exception 'an AI system keeps its id and organization'
      using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

revoke all on function private.guard_ai_system_update()
  from public, anon, authenticated;

create trigger ai_systems_guard_update
  before update on public.ai_systems
  for each row execute function private.guard_ai_system_update();

-- Audit (owner, 2026-09-21, on the PR #22 review). The event types are added
-- to audit_events' list here; features/organizations/audit/audit-events.ts
-- mirrors them, and a unit test keeps the two in step.
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
      'disclosure.published',
      'report.generated',
      'billing.plan_changed'
    )
  );

-- Writes the audit row for every insert and every change, in the same
-- transaction, whether the write came through the application or straight
-- through the Data API. Security definer, because users have no insert grant
-- on audit_events: the only rows it writes are these, with the actor taken
-- from the JWT, never from the row.
--
--   insert                 -> ai_system.created    {}
--   status changes         -> ai_system.archived / ai_system.unarchived  {}
--   name, description, system_type or provider changes
--                          -> ai_system.updated    {"fields": [...]}
--
-- `fields` names the columns only, never their values: the audit log holds no
-- free text. An update that changes nothing audited writes nothing.
--
-- No signed-in user means no actor, and an audit row must have one, so such a
-- write is refused. That includes the service role.
create function private.audit_ai_system_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_fields text[];
begin
  if tg_op = 'INSERT' then
    if v_actor is null then
      raise exception 'AI systems are created by a signed-in user'
        using errcode = '42501';
    end if;
    insert into public.audit_events
      (organization_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values
      (new.organization_id, v_actor, 'ai_system.created', 'ai_system', new.id, '{}'::jsonb);
    return null;
  end if;

  v_fields := array_remove(array[
    case when new.name is distinct from old.name then 'name' end,
    case when new.description is distinct from old.description then 'description' end,
    case when new.system_type is distinct from old.system_type then 'system_type' end,
    case when new.provider is distinct from old.provider then 'provider' end
  ], null);

  if cardinality(v_fields) = 0 and new.status = old.status then
    return null;
  end if;

  if v_actor is null then
    raise exception 'AI systems are changed by a signed-in user'
      using errcode = '42501';
  end if;

  if cardinality(v_fields) > 0 then
    insert into public.audit_events
      (organization_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values
      (new.organization_id, v_actor, 'ai_system.updated', 'ai_system', new.id,
       jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;

  if new.status <> old.status then
    insert into public.audit_events
      (organization_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values
      (new.organization_id, v_actor,
       case new.status when 'archived' then 'ai_system.archived' else 'ai_system.unarchived' end,
       'ai_system', new.id, '{}'::jsonb);
  end if;

  return null;
end;
$$;

revoke all on function private.audit_ai_system_change()
  from public, anon, authenticated;

create trigger ai_systems_audit_insert
  after insert on public.ai_systems
  for each row execute function private.audit_ai_system_change();

create trigger ai_systems_audit_update
  after update on public.ai_systems
  for each row execute function private.audit_ai_system_change();

-- Grants. Start from nothing. Column lists keep `id`, `organization_id` on
-- update, `status` on insert, and the timestamps out of a user's hands. No
-- delete grant: users archive.
revoke all on table public.ai_systems from anon, authenticated;

grant select on table public.ai_systems to authenticated;
grant insert (organization_id, name, description, system_type, provider)
  on table public.ai_systems to authenticated;
grant update (name, description, system_type, provider, status)
  on table public.ai_systems to authenticated;

-- Every member of a live organization reads its systems.
create policy ai_systems_select_member
  on public.ai_systems
  for select
  to authenticated
  using (
    authz.has_org_role(
      organization_id,
      array['owner', 'admin', 'member', 'viewer']
    )
  );

-- Members and up create and edit (`systems.manage`). The check on update
-- uses the new row's organization, which the column grant already fixes.
create policy ai_systems_insert_member
  on public.ai_systems
  for insert
  to authenticated
  with check (
    authz.has_org_role(organization_id, array['owner', 'admin', 'member'])
  );

create policy ai_systems_update_member
  on public.ai_systems
  for update
  to authenticated
  using (
    authz.has_org_role(organization_id, array['owner', 'admin', 'member'])
  )
  with check (
    authz.has_org_role(organization_id, array['owner', 'admin', 'member'])
  );

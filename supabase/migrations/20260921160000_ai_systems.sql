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

create table public.ai_systems (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  -- Shown in the dashboard, the widget's configuration and reports: one line,
  -- no control characters.
  name text not null
    constraint ai_systems_name_check check (
      char_length(name) between 1 and 120
      and name = btrim(name)
      and name !~ '[[:cntrl:]]'
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

-- `created_at` is the database's too. `updated_at` is kept by the shared
-- trigger function.
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

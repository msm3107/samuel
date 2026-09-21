-- Organizations and memberships (TASK-004): the tenant boundary every later
-- table resolves through.
--
-- Access is decided here, from `memberships`, and never from a claim the client
-- could influence: the only identity used is `auth.uid()`, the subject of the
-- JWT that Supabase Auth signed.

-- Helpers that RLS policies call. Not exposed through the Data API, which
-- serves `public` and `graphql_public` only, so no one can call them directly.
-- Kept apart from `private`, which the signed-in role must never be able to
-- use at all.
create schema if not exists authz;
revoke all on schema authz from public, anon, authenticated;
grant usage on schema authz to authenticated;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
    check (char_length(name) between 1 and 120 and name = btrim(name)),
  -- Lowercase letters, digits and single inner hyphens, 3 to 63 characters:
  -- safe in a URL path and a DNS label. Unique across deleted organizations
  -- too, so a released slug can never be taken over by someone else.
  slug text not null unique
    check (
      char_length(slug) between 3 and 63
      and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft deletion (README §33). A deleted organization grants no access.
  deleted_at timestamptz
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One role per user per organization. Also the index for memberships by
  -- organization, which is its leading column.
  constraint memberships_organization_user_key
    unique (organization_id, user_id)
);

-- Memberships by user: how every request finds the caller's organizations.
create index memberships_user_id_idx on public.memberships (user_id);

-- RLS is on before any grant below takes effect.
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;

comment on table public.organizations is
  'A customer or agency. Every tenant-owned row resolves to one.';
comment on table public.memberships is
  'Maps a user to an organization with one role. The only source of access.';

-- Whether the signed-in user holds one of `p_roles` in a live organization.
--
-- Security definer so that policies on `memberships` can read `memberships`
-- without recursing into their own RLS. It answers only for `auth.uid()`: the
-- caller cannot name another user.
create function authz.has_org_role(p_organization_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
      and o.deleted_at is null
  );
$$;

revoke all on function authz.has_org_role(uuid, text[])
  from public, anon, authenticated;
grant execute on function authz.has_org_role(uuid, text[]) to authenticated;

-- Keeps `updated_at` truthful whatever the client sends.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function private.set_updated_at();

-- An organization that exists always has an owner.
--
-- A partial unique index can say "at most one owner" but not "at least one",
-- so this is a trigger. It runs for every role, the service role included.
-- Removing or demoting the last owner is refused, unless the organization row
-- itself is gone: deleting an organization cascades to its memberships.
--
-- The organization row is locked first, so two owners demoting each other at
-- the same time are serialized and the second sees the first's change.
create function private.ensure_organization_keeps_an_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' then
    return null;
  end if;

  if tg_op = 'UPDATE'
    and new.role = 'owner'
    and new.organization_id = old.organization_id then
    return null;
  end if;

  perform 1
  from public.organizations
  where id = old.organization_id
  for update;

  if not found then
    return null;
  end if;

  if not exists (
    select 1
    from public.memberships
    where organization_id = old.organization_id
      and role = 'owner'
  ) then
    raise exception 'an organization must keep at least one owner'
      using errcode = '23514';
  end if;

  return null;
end;
$$;

revoke all on function private.ensure_organization_keeps_an_owner()
  from public, anon, authenticated;

create trigger memberships_keep_an_owner
  after update or delete on public.memberships
  for each row execute function private.ensure_organization_keeps_an_owner();

-- Grants. Supabase's defaults give `anon` and `authenticated` every privilege
-- on new tables in `public`; start from nothing and grant what is used.
-- Creating organizations and adding members go through dedicated functions in
-- later tasks, so there is no insert grant here.
revoke all on table public.organizations from anon, authenticated;
revoke all on table public.memberships from anon, authenticated;

grant select on table public.organizations to authenticated;
grant update (name) on table public.organizations to authenticated;

grant select on table public.memberships to authenticated;
grant update (role) on table public.memberships to authenticated;
grant delete on table public.memberships to authenticated;

-- Policies (README §10). Every member can see their organization.
create policy organizations_select_member
  on public.organizations
  for select
  to authenticated
  using (
    authz.has_org_role(id, array['owner', 'admin', 'member', 'viewer'])
  );

-- Renaming an organization is for owners and admins.
create policy organizations_update_owner_or_admin
  on public.organizations
  for update
  to authenticated
  using (authz.has_org_role(id, array['owner', 'admin']))
  with check (authz.has_org_role(id, array['owner', 'admin']));

-- A user sees their own memberships; owners and admins see their team's.
create policy memberships_select_own_or_manager
  on public.memberships
  for select
  to authenticated
  using (
    (
      user_id = (select auth.uid())
      and authz.has_org_role(
        organization_id,
        array['owner', 'admin', 'member', 'viewer']
      )
    )
    or authz.has_org_role(organization_id, array['owner', 'admin'])
  );

-- Owners change any role. Admins manage members except owners: they cannot
-- change an owner's row or make anyone an owner.
create policy memberships_update_manager
  on public.memberships
  for update
  to authenticated
  using (
    authz.has_org_role(organization_id, array['owner'])
    or (
      role <> 'owner'
      and authz.has_org_role(organization_id, array['admin'])
    )
  )
  with check (
    authz.has_org_role(organization_id, array['owner'])
    or (
      role <> 'owner'
      and authz.has_org_role(organization_id, array['admin'])
    )
  );

-- A user may leave; owners remove anyone; admins remove anyone but an owner.
-- The last owner is protected by the trigger above either way.
create policy memberships_delete_self_or_manager
  on public.memberships
  for delete
  to authenticated
  using (
    user_id = (select auth.uid())
    or authz.has_org_role(organization_id, array['owner'])
    or (
      role <> 'owner'
      and authz.has_org_role(organization_id, array['admin'])
    )
  );

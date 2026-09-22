-- TASK-014: every deployment's public identifier, the value a customer puts
-- in the widget's `data-deployment` attribute (README §11, §67).
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-22:
--   - The database generates it: no insert can skip it or choose it, the
--     service role's included, and the rows that already exist are filled
--     the same way.
--   - `dep_` and 26 characters of lowercase base32 (a-z, 2-7): 130 random
--     bits. Safe in HTML attributes and URLs.
--   - Fixed for the deployment's life. Archiving revokes it (an archived
--     deployment, or one whose AI system is archived, resolves to nothing:
--     TASK-019), and registering the hostname again issues a new one.
--   - The lookup from public ID to deployment is TASK-019's, with the
--     public endpoint that uses it.
--
-- The ID is public by design: it sits in the customer's HTML. It is never
-- authorization (README §67); it only names which disclosure to render.
--
-- Also, as decided on the PR #27 review (note 2): the archived-system
-- refusal carries a fixed hint, so the application matches the code and the
-- hint instead of the message text.

-- One generator for every public identifier (Phase 9's report IDs will
-- call it too). Each character is one random byte masked to 5 bits: 256 is
-- a multiple of 32, so every character is equally likely.
create function private.generate_public_id(p_prefix text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_bytes bytea := extensions.gen_random_bytes(26);
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  v_id text := '';
begin
  if p_prefix is null or p_prefix !~ '^[a-z]{2,8}$' then
    raise exception 'a public ID prefix is 2 to 8 lowercase letters'
      using errcode = '22023';
  end if;
  for i in 0..25 loop
    v_id := v_id || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  return p_prefix || '_' || v_id;
end;
$$;

revoke all on function private.generate_public_id(text)
  from public, anon, authenticated;

-- A volatile default is evaluated once per existing row while the table is
-- rewritten, and fires no triggers, so no row's updated_at moves and no
-- audit event is written. The default is dropped straight after: a
-- default runs with the inserting user's privileges, and users can't
-- execute the generator. New rows get theirs from the trigger below.
alter table public.deployments
  add column public_id text not null
    default private.generate_public_id('dep');

alter table public.deployments
  alter column public_id drop default,
  add constraint deployments_public_id_check
    check (public_id ~ '^dep_[a-z2-7]{26}$'),
  add constraint deployments_public_id_key unique (public_id);

-- Every new deployment's ID is the database's, whatever the insert said.
-- Users can't name the column anyway (their insert grant lists three
-- columns); this covers every other writer. Security definer, because the
-- inserting user can't execute the generator; it sets one column and
-- nothing else.
create function private.set_deployment_public_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.public_id := private.generate_public_id('dep');
  return new;
end;
$$;

revoke all on function private.set_deployment_public_id()
  from public, anon, authenticated;

create trigger deployments_set_public_id
  before insert on public.deployments
  for each row execute function private.set_deployment_public_id();

-- The public ID joins what no writer changes.
create or replace function private.guard_deployment_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.organization_id <> old.organization_id
    or new.ai_system_id <> old.ai_system_id
    or new.hostname <> old.hostname
    or new.public_id <> old.public_id
  then
    raise exception 'a deployment keeps its id, public ID, organization, AI system and hostname'
      using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- As before, plus a fixed hint the application can match (PR #27 review,
-- note 2), so rewording the message can't turn a 409 into a 500.
create or replace function private.require_active_ai_system()
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
      using errcode = '23514',
        constraint = 'deployments_ai_system_active',
        hint = 'ai_system_archived';
  end if;
  return null;
end;
$$;

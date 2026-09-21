-- public.create_organization (TASK-007), tested inside the database.
--
-- The Vitest suites cover the function through the route. This file covers
-- what only the database can show: that a failure after the organization
-- insert leaves nothing behind, and who may execute the function at all.
-- Runs with `pnpm test:db`; everything rolls back.
begin;

select plan(27);

insert into auth.users (id, email)
values
  ('00000000-0000-4000-8000-00000000c001', 'pgtap-creator@example.test'),
  ('00000000-0000-4000-8000-00000000c002', 'pgtap-capped@example.test');

-- Acts as a signed-in user, the way PostgREST does for a request.
create function pg_temp.act_as(p_user_id uuid)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
$$;

-- Privileges -----------------------------------------------------------------

select ok(
  has_function_privilege('authenticated', 'public.create_organization(text)', 'execute'),
  'a signed-in user may create an organization'
);
select ok(
  not has_function_privilege('anon', 'public.create_organization(text)', 'execute'),
  'an anonymous caller may not'
);
select ok(
  not has_function_privilege('service_role', 'public.create_organization(text)', 'execute'),
  'the service role may not: it has no user to own the organization'
);

-- Creation -------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-4000-8000-00000000c001');

create temporary table created on commit drop as
select public.create_organization('Pgtap Acme') as result;

reset role;

select is(
  (select result ->> 'slug' from created),
  'pgtap-acme',
  'the slug is derived from the name'
);

select is(
  (select array_agg(key order by key) from created, jsonb_object_keys(result) as key),
  array['id', 'name', 'slug'],
  'the function returns the id, name and slug only'
);

select is(
  (
    select role from public.memberships
    where organization_id = (select (result ->> 'id')::uuid from created)
      and user_id = '00000000-0000-4000-8000-00000000c001'
  ),
  'owner',
  'the caller owns the new organization'
);

select is(
  (
    select count(*)::int from public.memberships
    where organization_id = (select (result ->> 'id')::uuid from created)
  ),
  1,
  'and is its only member'
);

select results_eq(
  $$
    select event_type, entity_type, metadata, actor_user_id
    from public.audit_events
    where organization_id = (select (result ->> 'id')::uuid from created)
    order by event_type
  $$,
  $$
    values
      ('member.added', 'membership', '{"role": "owner"}'::jsonb,
       '00000000-0000-4000-8000-00000000c001'::uuid),
      ('organization.created', 'organization', '{}'::jsonb,
       '00000000-0000-4000-8000-00000000c001'::uuid)
  $$,
  'both audit events are written, naming the caller'
);

select is(
  (
    select entity_id from public.audit_events
    where event_type = 'member.added'
      and organization_id = (select (result ->> 'id')::uuid from created)
  ),
  (
    select id from public.memberships
    where organization_id = (select (result ->> 'id')::uuid from created)
  ),
  'member.added points at the owner membership'
);

-- Slugs ----------------------------------------------------------------------

select pg_temp.act_as('00000000-0000-4000-8000-00000000c001');

select matches(
  public.create_organization('Pgtap Acme') ->> 'slug',
  '^pgtap-acme-[0-9a-f]{6}$',
  'a taken slug gets a random suffix, never an error'
);
select is(
  public.create_organization('Zażółć Gęślą Jaźń') ->> 'slug',
  'zazolc-gesla-jazn',
  'accents are dropped and ł becomes l'
);
select is(
  public.create_organization('Straße & Søn — Øresund') ->> 'slug',
  'strasse-son-oresund',
  'ß, ø and punctuation are mapped'
);
select matches(
  public.create_organization('Admin') ->> 'slug',
  '^admin-[0-9a-f]{6}$',
  'a reserved word is never a slug on its own'
);
select matches(
  public.create_organization('AI') ->> 'slug',
  '^ai-[0-9a-f]{6}$',
  'a slug shorter than three characters is lengthened'
);
select matches(
  public.create_organization('!!!') ->> 'slug',
  '^org-[0-9a-f]{6}$',
  'a name with no letters or digits still gets a slug'
);

-- Names ----------------------------------------------------------------------

select throws_ok(
  $$ select public.create_organization('') $$,
  '22023', 'the organization name is not acceptable',
  'an empty name is refused'
);
select throws_ok(
  $$ select public.create_organization(' Padded') $$,
  '22023', 'the organization name is not acceptable',
  'a name with surrounding spaces is refused'
);
select throws_ok(
  $$ select public.create_organization(repeat('x', 121)) $$,
  '22023', 'the organization name is not acceptable',
  'a name over 120 characters is refused'
);
select throws_ok(
  $$ select public.create_organization(E'Line\nbreak') $$,
  '22023', 'the organization name is not acceptable',
  'a name with a control character is refused'
);

reset role;

-- A failure after the organization insert ------------------------------------

-- Every audit insert fails, so the function fails after the organization and
-- the membership exist. The whole call must roll back.
create function pg_temp.fail_audit_insert()
returns trigger
language plpgsql
as $$
begin
  raise exception 'simulated audit failure';
end;
$$;

create trigger pgtap_fail_audit_insert
  before insert on public.audit_events
  for each row execute function pg_temp.fail_audit_insert();

select pg_temp.act_as('00000000-0000-4000-8000-00000000c001');

select throws_ok(
  $$ select public.create_organization('Pgtap Half Made') $$,
  'P0001', 'simulated audit failure',
  'a failed audit write fails the creation'
);

reset role;

select is(
  (select count(*)::int from public.organizations where name = 'Pgtap Half Made'),
  0,
  'and leaves no organization behind, so none is ever ownerless'
);

drop trigger pgtap_fail_audit_insert on public.audit_events;

-- Who is the owner -----------------------------------------------------------

select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role authenticated;

select throws_ok(
  $$ select public.create_organization('Pgtap Nobody') $$,
  '42501', 'a signed-in user is required',
  'a call with no user in the JWT is refused'
);

reset role;

-- The hourly cap -------------------------------------------------------------

select pg_temp.act_as('00000000-0000-4000-8000-00000000c002');

select lives_ok(
  $$
    select public.create_organization('Pgtap Capped ' || n)
    from generate_series(1, 10) as n
  $$,
  'ten organizations in an hour are allowed'
);
select throws_ok(
  $$ select public.create_organization('Pgtap Capped 11') $$,
  'PT429', 'organization creation limit reached',
  'the eleventh is refused'
);

reset role;

select is(
  (
    select count(*)::int from public.memberships
    where user_id = '00000000-0000-4000-8000-00000000c002'
  ),
  10,
  'and was not created'
);

-- Giving the organizations away does not reset the cap: it counts creations,
-- not current ownership.
update public.memberships
set user_id = '00000000-0000-4000-8000-00000000c001'
where user_id = '00000000-0000-4000-8000-00000000c002';

select is(
  (
    select count(*)::int from public.memberships
    where user_id = '00000000-0000-4000-8000-00000000c002'
  ),
  0,
  'the capped user now owns nothing'
);

select pg_temp.act_as('00000000-0000-4000-8000-00000000c002');

select throws_ok(
  $$ select public.create_organization('Pgtap Capped 12') $$,
  'PT429', 'organization creation limit reached',
  'and is still refused'
);

reset role;

select * from finish();

rollback;

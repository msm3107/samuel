-- deployments.public_id (TASK-014): the generator, the column, the trigger
-- that sets it, and the guard that keeps it. The Data API side is tested in
-- tests/integration/database/deployment-public-id.supabase.ts. Runs with
-- `pnpm test:db`; everything rolls back.
begin;

select plan(23);

insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-0000000001f1', 'Pgtap Public Ids', 'pgtap-public-ids');

-- The audit triggers refuse a write with no actor. The claim is set as
-- PostgREST sets it; the role stays the table owner, so this tests what
-- every writer gets, not only what RLS and the grants allow users.
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-8000-0000000001e1', 'role', 'authenticated')::text,
  true
);

insert into public.ai_systems (id, organization_id, name, system_type)
values ('00000000-0000-4000-8000-0000000001a1', '00000000-0000-4000-8000-0000000001f1', 'Chat', 'chatbot');

-- The generator ------------------------------------------------------------------

select matches(
  private.generate_public_id('dep'), '^dep_[a-z2-7]{26}$',
  'a deployment ID is dep_ and 26 base32 characters'
);
select matches(
  private.generate_public_id('rep'), '^rep_[a-z2-7]{26}$',
  'the same generator serves other prefixes (Phase 9''s reports)'
);
select throws_ok(
  $$ select private.generate_public_id('Dep') $$,
  '22023', 'a public ID prefix is 2 to 8 lowercase letters',
  'a prefix with a capital is refused'
);
select throws_ok(
  $$ select private.generate_public_id('d') $$,
  '22023', NULL, 'a one-letter prefix is refused'
);
select throws_ok(
  $$ select private.generate_public_id('dep_x') $$,
  '22023', NULL, 'a prefix with an underscore is refused'
);
select throws_ok(
  $$ select private.generate_public_id(NULL) $$,
  '22023', NULL, 'no prefix is refused'
);

create temporary table generated on commit drop as
select private.generate_public_id('dep') as id
from generate_series(1, 5000);

select is(
  (select count(distinct id)::int from generated), 5000,
  '5000 generated IDs are all different'
);
select is(
  (select count(*)::int from generated where id !~ '^dep_[a-z2-7]{26}$'), 0,
  'every generated ID has the shape'
);
-- 5000 IDs of 26 characters: 130,000 draws over 32 characters, about 4,062
-- each. A character the generator never or rarely picks (a biased mask, a
-- short alphabet) falls far outside 3,500 to 4,600.
select ok(
  (select min(n) > 3500 and max(n) < 4600 and count(*) = 32
   from (
     select count(*) as n
     from generated, regexp_split_to_table(substr(id, 5), '') as c
     group by c
   ) as counts),
  'all 32 characters are used, about equally often'
);

-- Privileges -------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'private.generate_public_id(text)', 'execute')
  and not has_function_privilege('anon', 'private.generate_public_id(text)', 'execute'),
  'no API role can call the generator'
);
select ok(
  not has_function_privilege('authenticated', 'private.set_deployment_public_id()', 'execute')
  and not has_function_privilege('anon', 'private.set_deployment_public_id()', 'execute'),
  'no API role can call the trigger function'
);
select ok(
  not has_column_privilege('authenticated', 'public.deployments', 'public_id', 'insert')
  and not has_column_privilege('authenticated', 'public.deployments', 'public_id', 'update'),
  'a user cannot set the public ID on insert or change it after'
);
select ok(
  has_column_privilege('authenticated', 'public.deployments', 'public_id', 'select'),
  'a member can read the public ID (RLS decides which rows)'
);
select ok(
  not has_table_privilege('anon', 'public.deployments', 'select'),
  'an anonymous caller cannot read deployments, public IDs included'
);

-- The column -------------------------------------------------------------------

select col_not_null('public', 'deployments', 'public_id', 'every deployment has a public ID');
select col_hasnt_default(
  'public', 'deployments', 'public_id',
  'no default: a default would run with the inserting user''s privileges'
);
select col_is_unique('public', 'deployments', 'public_id', 'public IDs are unique');

-- Set by the database -------------------------------------------------------------

insert into public.deployments (organization_id, ai_system_id, hostname)
values ('00000000-0000-4000-8000-0000000001f1', '00000000-0000-4000-8000-0000000001a1', 'plain.example.com');

select matches(
  (select public_id from public.deployments where hostname = 'plain.example.com'),
  '^dep_[a-z2-7]{26}$',
  'a new deployment gets a public ID'
);

insert into public.deployments (organization_id, ai_system_id, hostname, public_id)
values (
  '00000000-0000-4000-8000-0000000001f1', '00000000-0000-4000-8000-0000000001a1',
  'chosen.example.com', 'dep_aaaaaaaaaaaaaaaaaaaaaaaaaa'
);

select isnt(
  (select public_id from public.deployments where hostname = 'chosen.example.com'),
  'dep_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  'an ID named on insert is replaced, even by the table owner'
);

select throws_ok(
  $$ update public.deployments set public_id = 'dep_bbbbbbbbbbbbbbbbbbbbbbbbbb'
     where hostname = 'plain.example.com' $$,
  '42501', 'a deployment keeps its id, public ID, organization, AI system and hostname',
  'the public ID cannot be changed, even by the table owner'
);

-- Archive revokes, re-registering issues a new ID (owner, 2026-09-22).
create temporary table first_id on commit drop as
select public_id from public.deployments where hostname = 'plain.example.com';

update public.deployments set status = 'archived' where hostname = 'plain.example.com';
insert into public.deployments (organization_id, ai_system_id, hostname)
values ('00000000-0000-4000-8000-0000000001f1', '00000000-0000-4000-8000-0000000001a1', 'plain.example.com');

select is(
  (select count(distinct public_id)::int from public.deployments where hostname = 'plain.example.com'),
  2,
  'registering an archived hostname again issues a new public ID'
);
select is(
  (select public_id from public.deployments
   where hostname = 'plain.example.com' and status = 'archived'),
  (select public_id from first_id),
  'archiving keeps the old deployment''s ID (it resolves to nothing: TASK-019)'
);

-- The archived-system refusal's hint (PR #27 review, note 2) ---------------------

update public.ai_systems set status = 'archived'
where id = '00000000-0000-4000-8000-0000000001a1';

create function pg_temp.refusal_of_archived_system()
returns text
language plpgsql
as $$
declare
  v_hint text;
begin
  insert into public.deployments (organization_id, ai_system_id, hostname)
  values ('00000000-0000-4000-8000-0000000001f1', '00000000-0000-4000-8000-0000000001a1', 'late.example.com');
  return 'no error';
exception when check_violation then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end;
$$;

select is(
  pg_temp.refusal_of_archived_system(), 'ai_system_archived',
  'a deployment under an archived AI system is refused with the fixed hint'
);

select * from finish();

rollback;

-- public.ai_systems (TASK-008): constraints, grants and triggers, tested in
-- the database. Access through RLS is tested against the Data API in
-- tests/security/tenant-isolation/ai-systems.supabase.ts. Runs with
-- `pnpm test:db`; everything rolls back.
begin;

select plan(26);

insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-0000000000d1', 'Pgtap Systems', 'pgtap-systems');

-- Structure --------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.ai_systems'::regclass),
  'row-level security is enabled'
);
select col_not_null('public', 'ai_systems', 'organization_id', 'organization_id is required');
select fk_ok(
  'public', 'ai_systems', 'organization_id',
  'public', 'organizations', 'id',
  'organization_id references organizations'
);
select col_is_unique(
  'public', 'ai_systems', array['organization_id', 'id'],
  '(organization_id, id) is unique, for later composite foreign keys'
);

-- Privileges: no delete, and the columns a user may set ------------------------

select ok(
  not has_table_privilege('authenticated', 'public.ai_systems', 'delete'),
  'a signed-in user has no delete'
);
select ok(
  not has_table_privilege('anon', 'public.ai_systems', 'select'),
  'the anon role reads nothing'
);
select ok(
  not has_column_privilege('authenticated', 'public.ai_systems', 'organization_id', 'update'),
  'organization_id cannot be changed'
);
select ok(
  not has_column_privilege('authenticated', 'public.ai_systems', 'status', 'insert'),
  'a system cannot be created archived'
);
select ok(
  not has_column_privilege('authenticated', 'public.ai_systems', 'id', 'insert')
    and not has_column_privilege('authenticated', 'public.ai_systems', 'created_at', 'insert')
    and not has_column_privilege('authenticated', 'public.ai_systems', 'created_at', 'update')
    and not has_column_privilege('authenticated', 'public.ai_systems', 'updated_at', 'update'),
  'id and the timestamps are not a user''s to set'
);

-- Constraints ------------------------------------------------------------------

create function pg_temp.insert_system(
  p_name text,
  p_type text default 'chatbot',
  p_description text default null,
  p_provider text default null
)
returns uuid
language sql
as $$
  insert into public.ai_systems
    (organization_id, name, system_type, description, provider)
  values
    ('00000000-0000-4000-8000-0000000000d1', p_name, p_type, p_description, p_provider)
  returning id;
$$;

select lives_ok(
  $$ select pg_temp.insert_system('Support Bot', 'chatbot', E'Answers questions.\nIn two lines.', 'OpenAI') $$,
  'a valid system with a multi-line description is accepted'
);

select throws_ok(
  $$ select pg_temp.insert_system('Robot', 'robot') $$,
  '23514', null, 'an unknown system_type is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system('') $$,
  '23514', null, 'an empty name is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system(' Padded') $$,
  '23514', null, 'a name with surrounding spaces is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system(E'Two\nlines') $$,
  '23514', null, 'a name with a line break is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system(repeat('x', 121)) $$,
  '23514', null, 'a name over 120 characters is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system('Bell', 'chatbot', E'Ding\x07') $$,
  '23514', null, 'a description with a control character other than a line break is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system('Long', 'chatbot', repeat('x', 2001)) $$,
  '23514', null, 'a description over 2000 characters is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system('Vendor', 'chatbot', null, repeat('x', 101)) $$,
  '23514', null, 'a provider over 100 characters is refused'
);
select throws_ok(
  $$ update public.ai_systems set status = 'deleted' where name = 'Support Bot' $$,
  '23514', null, 'an unknown status is refused'
);

-- Names ------------------------------------------------------------------------

select throws_ok(
  $$ select pg_temp.insert_system('SUPPORT bot') $$,
  '23505', null, 'an active name is unique, whatever the case'
);

update public.ai_systems set status = 'archived' where name = 'Support Bot';

select lives_ok(
  $$ select pg_temp.insert_system('Support Bot') $$,
  'an archived system''s name can be reused'
);
select throws_ok(
  $$ update public.ai_systems set status = 'active'
     where name = 'Support Bot' and status = 'archived' $$,
  '23505', null, 'unarchiving into a taken name is refused'
);

-- Timestamps -------------------------------------------------------------------

insert into public.ai_systems
  (organization_id, name, system_type, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000000d1', 'Backdated', 'other', '2000-01-01', '2000-01-01');

select ok(
  (select created_at > now() - interval '1 minute' and updated_at = created_at
   from public.ai_systems where name = 'Backdated'),
  'created_at and updated_at are the database''s, even for the table owner'
);

update public.ai_systems
set description = 'Changed', updated_at = '2000-01-01'
where name = 'Backdated';

select ok(
  (select updated_at > now() - interval '1 minute'
   from public.ai_systems where name = 'Backdated'),
  'updated_at is the database''s on update'
);

-- Deleting the organization -----------------------------------------------------

delete from public.organizations where id = '00000000-0000-4000-8000-0000000000d1';

select is(
  (select count(*)::int from public.ai_systems
   where organization_id = '00000000-0000-4000-8000-0000000000d1'),
  0,
  'a hard-deleted organization takes its systems with it'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'ai_systems_active_name_key'
      and indexdef like '%WHERE (status = ''active''::text)%'
  ),
  'the name index covers active systems only'
);

select * from finish();

rollback;

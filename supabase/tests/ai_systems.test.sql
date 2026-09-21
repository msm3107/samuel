-- public.ai_systems (TASK-008): constraints, grants and triggers, tested in
-- the database. Access through RLS is tested against the Data API in
-- tests/security/tenant-isolation/ai-systems.supabase.ts. Runs with
-- `pnpm test:db`; everything rolls back.
begin;

select plan(42);

insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-0000000000d1', 'Pgtap Systems', 'pgtap-systems');

-- Every write below needs a signed-in user: the audit trigger refuses a
-- write with no actor. The claim is set as PostgREST sets it; the role stays
-- the table owner, so constraints are tested without RLS in the way.
create function pg_temp.sign_in_as(p_user_id uuid)
returns void
language sql
as $$
  select set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
    true
  );
$$;

create function pg_temp.sign_out()
returns void
language sql
as $$
  select set_config('request.jwt.claims', '', true);
$$;

select pg_temp.sign_in_as('00000000-0000-4000-8000-0000000000e1');

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

-- Format characters (PR #22 review, finding 2) ---------------------------------

select throws_ok(
  $$ select pg_temp.insert_system(U&'Support\202EBot') $$,
  '23514', null, 'a name with a right-to-left override is refused'
);
select throws_ok(
  $$ select pg_temp.insert_system('Vendor Check', 'chatbot', null, U&'Open\200BAI') $$,
  '23514', null, 'a provider with a zero-width space is refused'
);
select lives_ok(
  $$ select pg_temp.insert_system(U&'\+01F469\200D\+01F4BB Helper') $$,
  'a name with an emoji joined by U+200D is accepted'
);

-- Fixed after insert (PR #22 review, finding 3) --------------------------------

select pg_temp.insert_system('Guarded');

update public.ai_systems set created_at = '2000-01-01' where name = 'Guarded';

select ok(
  (select created_at > now() - interval '1 minute'
   from public.ai_systems where name = 'Guarded'),
  'created_at cannot be changed, even by the table owner'
);
select throws_ok(
  $$ update public.ai_systems set id = gen_random_uuid() where name = 'Guarded' $$,
  '42501', 'an AI system keeps its id and organization',
  'the id cannot be changed, even by the table owner'
);

insert into public.organizations (id, name, slug)
values ('00000000-0000-4000-8000-0000000000d2', 'Pgtap Other', 'pgtap-other');

select throws_ok(
  $$ update public.ai_systems
     set organization_id = '00000000-0000-4000-8000-0000000000d2'
     where name = 'Guarded' $$,
  '42501', 'an AI system keeps its id and organization',
  'a system cannot move to another organization, even by the table owner'
);

-- Audit (PR #22 review, finding 1) ----------------------------------------------

create temporary table audited on commit drop as
select pg_temp.insert_system('Audited', 'chatbot', null, 'OpenAI') as id;

create function pg_temp.events_for_audited()
returns table (event_type text, metadata jsonb, actor_user_id uuid)
language sql
as $$
  select event_type, metadata, actor_user_id
  from public.audit_events
  where entity_id = (select id from audited)
  order by created_at, event_type;
$$;

select results_eq(
  $$ select * from pg_temp.events_for_audited() $$,
  $$ values ('ai_system.created', '{}'::jsonb,
             '00000000-0000-4000-8000-0000000000e1'::uuid) $$,
  'an insert writes ai_system.created, naming the signed-in user'
);

select is(
  (select entity_type from public.audit_events
   where entity_id = (select id from audited)),
  'ai_system',
  'the event describes the system'
);

update public.ai_systems
set description = 'Changed', provider = null
where id = (select id from audited);

select is(
  (select metadata from public.audit_events
   where entity_id = (select id from audited) and event_type = 'ai_system.updated'),
  '{"fields": ["description", "provider"]}'::jsonb,
  'an edit writes ai_system.updated naming the changed columns, never their values'
);

update public.ai_systems set name = name where id = (select id from audited);

select is(
  (select count(*)::int from public.audit_events
   where entity_id = (select id from audited)),
  2,
  'an update that changes nothing audited writes nothing'
);

update public.ai_systems
set status = 'archived', name = 'Audited Old'
where id = (select id from audited);

select is(
  (select array_agg(event_type order by event_type) from public.audit_events
   where entity_id = (select id from audited)),
  array['ai_system.archived', 'ai_system.created', 'ai_system.updated', 'ai_system.updated'],
  'archiving while renaming writes both events'
);

update public.ai_systems set status = 'active' where id = (select id from audited);

select is(
  (select count(*)::int from public.audit_events
   where entity_id = (select id from audited) and event_type = 'ai_system.unarchived'),
  1,
  'un-archiving writes ai_system.unarchived'
);

select pg_temp.sign_out();

select throws_ok(
  $$ select pg_temp.insert_system('Nobody''s') $$,
  '42501', 'AI systems are created by a signed-in user',
  'a creation with no signed-in user, such as the service role, is refused'
);
select throws_ok(
  $$ update public.ai_systems set description = 'Anonymous edit'
     where id = (select id from audited) $$,
  '42501', 'AI systems are changed by a signed-in user',
  'a change with no signed-in user is refused'
);
select lives_ok(
  $$ update public.ai_systems set name = name where id = (select id from audited) $$,
  'an update with no signed-in user that changes nothing is allowed'
);

select pg_temp.sign_in_as('00000000-0000-4000-8000-0000000000e1');

-- The audit function: owner-only, and not callable directly.
select ok(
  not has_function_privilege('authenticated', 'private.audit_ai_system_change()', 'execute'),
  'a signed-in user cannot call the audit function directly'
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

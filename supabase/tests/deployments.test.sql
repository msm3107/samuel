-- public.deployments (TASK-011): constraints, grants and triggers, tested in
-- the database. Access through RLS is tested against the Data API in
-- tests/security/tenant-isolation/deployments.supabase.ts. Runs with
-- `pnpm test:db`; everything rolls back.
begin;

select plan(64);

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-0000000000f1', 'Pgtap Deployments', 'pgtap-deployments'),
  ('00000000-0000-4000-8000-0000000000f2', 'Pgtap Elsewhere', 'pgtap-elsewhere');

-- Every write below needs a signed-in user: the audit triggers refuse a
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

insert into public.ai_systems (id, organization_id, name, system_type)
values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000f1', 'Chat', 'chatbot'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000f1', 'Voice', 'voice_agent'),
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000f2', 'Elsewhere', 'other');

create function pg_temp.insert_deployment(
  p_hostname text,
  p_system uuid default '00000000-0000-4000-8000-0000000000a1',
  p_organization uuid default '00000000-0000-4000-8000-0000000000f1'
)
returns uuid
language sql
as $$
  insert into public.deployments (organization_id, ai_system_id, hostname)
  values (p_organization, p_system, p_hostname)
  returning id;
$$;

-- Structure --------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.deployments'::regclass),
  'row-level security is enabled'
);
select col_not_null('public', 'deployments', 'organization_id', 'organization_id is required');
select col_not_null('public', 'deployments', 'ai_system_id', 'ai_system_id is required');
select fk_ok(
  'public', 'deployments', 'organization_id',
  'public', 'organizations', 'id',
  'organization_id references organizations'
);
select fk_ok(
  'public', 'deployments', array['organization_id', 'ai_system_id'],
  'public', 'ai_systems', array['organization_id', 'id'],
  'the AI system is referenced together with its organization'
);
select col_is_unique(
  'public', 'deployments', array['organization_id', 'id'],
  '(organization_id, id) is unique, for verification checks'' composite foreign key'
);

-- Privileges -------------------------------------------------------------------

select ok(
  not has_table_privilege('authenticated', 'public.deployments', 'delete'),
  'a signed-in user has no delete'
);
select ok(
  not has_table_privilege('anon', 'public.deployments', 'select'),
  'the anon role reads nothing'
);
select ok(
  not has_column_privilege('authenticated', 'public.deployments', 'hostname', 'update')
    and not has_column_privilege('authenticated', 'public.deployments', 'ai_system_id', 'update')
    and not has_column_privilege('authenticated', 'public.deployments', 'organization_id', 'update'),
  'the hostname, AI system and organization cannot be changed'
);
select ok(
  not has_column_privilege('authenticated', 'public.deployments', 'status', 'insert'),
  'a deployment cannot be created archived'
);
select ok(
  not has_column_privilege('authenticated', 'public.deployments', 'id', 'insert')
    and not has_column_privilege('authenticated', 'public.deployments', 'created_at', 'insert')
    and not has_column_privilege('authenticated', 'public.deployments', 'updated_at', 'insert')
    and not has_column_privilege('authenticated', 'public.deployments', 'created_at', 'update')
    and not has_column_privilege('authenticated', 'public.deployments', 'updated_at', 'update'),
  'id and the timestamps are not a user''s to set'
);

-- Hostnames --------------------------------------------------------------------

select lives_ok(
  $$ select pg_temp.insert_deployment('support.example.com') $$,
  'a lowercase hostname is accepted'
);
select lives_ok(
  $$ select pg_temp.insert_deployment('xn--bcher-kva.example') $$,
  'a punycode-encoded IDN label is accepted'
);
select lives_ok(
  $$ select pg_temp.insert_deployment('a1-b2.co') $$,
  'digits and inner hyphens are accepted'
);
select lives_ok(
  $$ select pg_temp.insert_deployment(
       repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 61)) $$,
  'a 253-character hostname with 63-character labels is accepted'
);

select throws_ok(
  $$ select pg_temp.insert_deployment(
       repeat('a', 63) || '.' || repeat('b', 63) || '.' || repeat('c', 63) || '.' || repeat('d', 62)) $$,
  '23514', null, 'a 254-character hostname is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment(repeat('a', 64) || '.example.com') $$,
  '23514', null, 'a 64-character label is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('') $$,
  '23514', null, 'an empty hostname is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('Support.Example.com') $$,
  '23514', null, 'uppercase is refused: hostnames are stored normalized'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('example.com.') $$,
  '23514', null, 'a trailing dot is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('bücher.example') $$,
  '23514', null, 'an IDN label not punycode-encoded is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('localhost') $$,
  '23514', null, 'localhost, a single label, is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('127.0.0.1') $$,
  '23514', null, 'an IPv4 literal is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('169.254.169.254') $$,
  '23514', null, 'the cloud metadata address is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('0x7f.1') $$,
  '23514', null, 'a shorthand IPv4 literal is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('[::1]') $$,
  '23514', null, 'an IPv6 literal is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('example.com:8080') $$,
  '23514', null, 'a port is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('user@example.com') $$,
  '23514', null, 'embedded credentials are refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('https://example.com') $$,
  '23514', null, 'a URL with a scheme is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('example.com/path') $$,
  '23514', null, 'a path is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment(' example.com') $$,
  '23514', null, 'surrounding spaces are refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('example..com') $$,
  '23514', null, 'an empty label is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('-a.example.com') $$,
  '23514', null, 'a label starting with a hyphen is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('a-.example.com') $$,
  '23514', null, 'a label ending with a hyphen is refused'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('under_score.example.com') $$,
  '23514', null, 'an underscore is refused'
);
select throws_ok(
  $$ update public.deployments set status = 'deleted' where hostname = 'support.example.com' $$,
  '23514', null, 'an unknown status is refused'
);

-- Uniqueness (owner, 2026-09-22: per AI system, among active deployments) -----

select throws_ok(
  $$ select pg_temp.insert_deployment('support.example.com') $$,
  '23505', null, 'one system cannot have two active deployments on one hostname'
);
select lives_ok(
  $$ select pg_temp.insert_deployment('support.example.com', '00000000-0000-4000-8000-0000000000a2') $$,
  'another system can be deployed on the same hostname'
);
select lives_ok(
  $$ select pg_temp.insert_deployment(
       'support.example.com',
       '00000000-0000-4000-8000-0000000000a3',
       '00000000-0000-4000-8000-0000000000f2') $$,
  'another organization can name the same hostname'
);

update public.deployments set status = 'archived'
where ai_system_id = '00000000-0000-4000-8000-0000000000a1'
  and hostname = 'support.example.com';

select lives_ok(
  $$ select pg_temp.insert_deployment('support.example.com') $$,
  'an archived deployment''s hostname can be registered again'
);
select throws_ok(
  $$ update public.deployments set status = 'active'
     where ai_system_id = '00000000-0000-4000-8000-0000000000a1'
       and hostname = 'support.example.com' and status = 'archived' $$,
  '23505', null, 'restoring into a hostname taken again is refused'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'deployments_active_hostname_key'
      and indexdef like '%(ai_system_id, hostname)%'
      and indexdef like '%WHERE (status = ''active''::text)%'
  ),
  'the hostname index is per system and covers active deployments only'
);

-- The system belongs to the same organization ------------------------------------

select throws_ok(
  $$ select pg_temp.insert_deployment('cross.example.com', '00000000-0000-4000-8000-0000000000a3') $$,
  '23503', null, 'a deployment cannot point at another organization''s system'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('ghost.example.com', gen_random_uuid()) $$,
  '23503', null, 'a deployment cannot point at a system that does not exist'
);

-- Archived AI systems (owner, 2026-09-22) ------------------------------------------

select pg_temp.insert_deployment('voice.example.com', '00000000-0000-4000-8000-0000000000a2');
select pg_temp.insert_deployment('old-voice.example.com', '00000000-0000-4000-8000-0000000000a2');
update public.deployments set status = 'archived' where hostname = 'old-voice.example.com';

update public.ai_systems set status = 'archived'
where id = '00000000-0000-4000-8000-0000000000a2';

select is(
  (select status from public.deployments where hostname = 'voice.example.com'),
  'active',
  'archiving a system leaves its deployments as they are'
);
select throws_ok(
  $$ select pg_temp.insert_deployment('new-voice.example.com', '00000000-0000-4000-8000-0000000000a2') $$,
  '23514', 'a deployment''s AI system is archived',
  'a deployment cannot be created under an archived system'
);
select throws_ok(
  $$ update public.deployments set status = 'active' where hostname = 'old-voice.example.com' $$,
  '23514', 'a deployment''s AI system is archived',
  'a deployment cannot be restored under an archived system'
);
select lives_ok(
  $$ update public.deployments set status = 'archived' where hostname = 'voice.example.com' $$,
  'a deployment under an archived system can still be archived'
);

update public.ai_systems set status = 'active'
where id = '00000000-0000-4000-8000-0000000000a2';

select lives_ok(
  $$ update public.deployments set status = 'active' where hostname = 'old-voice.example.com' $$,
  'once the system is restored, its deployments can be too'
);

-- Timestamps -------------------------------------------------------------------

insert into public.deployments
  (organization_id, ai_system_id, hostname, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1',
   'backdated.example.com', '2000-01-01', '2000-01-01');

select ok(
  (select created_at > now() - interval '1 minute' and updated_at = created_at
   from public.deployments where hostname = 'backdated.example.com'),
  'created_at and updated_at are the database''s, even for the table owner'
);

update public.deployments
set status = 'archived', updated_at = '2000-01-01', created_at = '2000-01-01'
where hostname = 'backdated.example.com';

select ok(
  (select updated_at > now() - interval '1 minute'
     and created_at > now() - interval '1 minute'
   from public.deployments where hostname = 'backdated.example.com'),
  'updated_at is the database''s on update, and created_at cannot be changed'
);

-- Fixed after insert (owner, 2026-09-22) -----------------------------------------

select pg_temp.insert_deployment('fixed.example.com');

select throws_ok(
  $$ update public.deployments set hostname = 'moved.example.com'
     where hostname = 'fixed.example.com' $$,
  '42501', 'a deployment keeps its id, organization, AI system and hostname',
  'the hostname cannot be changed, even by the table owner'
);
select throws_ok(
  $$ update public.deployments set ai_system_id = '00000000-0000-4000-8000-0000000000a2'
     where hostname = 'fixed.example.com' $$,
  '42501', 'a deployment keeps its id, organization, AI system and hostname',
  'the AI system cannot be changed, even by the table owner'
);
select throws_ok(
  $$ update public.deployments set id = gen_random_uuid()
     where hostname = 'fixed.example.com' $$,
  '42501', 'a deployment keeps its id, organization, AI system and hostname',
  'the id cannot be changed, even by the table owner'
);
select throws_ok(
  $$ update public.deployments
     set organization_id = '00000000-0000-4000-8000-0000000000f2',
         ai_system_id = '00000000-0000-4000-8000-0000000000a3'
     where hostname = 'fixed.example.com' $$,
  '42501', 'a deployment keeps its id, organization, AI system and hostname',
  'a deployment cannot move to another organization, even by the table owner'
);

-- Audit ------------------------------------------------------------------------

create temporary table audited on commit drop as
select pg_temp.insert_deployment('audited.example.com') as id;

create function pg_temp.events_for_audited()
returns table (event_type text, entity_type text, metadata jsonb, actor_user_id uuid)
language sql
as $$
  select event_type, entity_type, metadata, actor_user_id
  from public.audit_events
  where entity_id = (select id from audited)
  order by created_at, event_type;
$$;

select results_eq(
  $$ select * from pg_temp.events_for_audited() $$,
  $$ values ('deployment.created', 'deployment', '{}'::jsonb,
             '00000000-0000-4000-8000-0000000000e1'::uuid) $$,
  'an insert writes deployment.created, naming the signed-in user, with no metadata'
);

update public.deployments set status = status where id = (select id from audited);

select is(
  (select count(*)::int from public.audit_events
   where entity_id = (select id from audited)),
  1,
  'an update that leaves the status alone writes nothing'
);

update public.deployments set status = 'archived' where id = (select id from audited);
update public.deployments set status = 'active' where id = (select id from audited);

select is(
  (select array_agg(event_type order by event_type) from public.audit_events
   where entity_id = (select id from audited)),
  array['deployment.archived', 'deployment.created', 'deployment.unarchived'],
  'archiving and restoring write deployment.archived and deployment.unarchived'
);

select is(
  (select count(*)::int from public.audit_events
   where entity_id = (select id from audited) and metadata <> '{}'::jsonb),
  0,
  'no deployment event carries metadata: the hostname stays out of the log'
);

select pg_temp.sign_out();

select throws_ok(
  $$ select pg_temp.insert_deployment('nobody.example.com') $$,
  '42501', 'deployments are changed by a signed-in user',
  'a creation with no signed-in user, such as the service role, is refused'
);
select throws_ok(
  $$ update public.deployments set status = 'archived' where id = (select id from audited) $$,
  '42501', 'deployments are changed by a signed-in user',
  'an archive with no signed-in user is refused'
);

select pg_temp.sign_in_as('00000000-0000-4000-8000-0000000000e1');

select ok(
  not has_function_privilege('authenticated', 'private.audit_deployment_change()', 'execute')
    and not has_function_privilege('authenticated', 'private.require_active_ai_system()', 'execute')
    and not has_function_privilege('authenticated', 'private.guard_deployment_update()', 'execute'),
  'a signed-in user cannot call the trigger functions directly'
);

-- Deletion by the service role cascades --------------------------------------------

delete from public.ai_systems where id = '00000000-0000-4000-8000-0000000000a2';

select is(
  (select count(*)::int from public.deployments
   where ai_system_id = '00000000-0000-4000-8000-0000000000a2'),
  0,
  'a hard-deleted system takes its deployments with it'
);

delete from public.organizations where id = '00000000-0000-4000-8000-0000000000f1';

select is(
  (select count(*)::int from public.deployments
   where organization_id = '00000000-0000-4000-8000-0000000000f1'),
  0,
  'a hard-deleted organization takes its deployments with it'
);

select * from finish();

rollback;

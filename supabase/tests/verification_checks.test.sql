-- verification_checks (TASK-022): the constraints, the grants and the
-- append-only triggers, tested as the table owner.
--
-- The Vitest suites reach the database through the API, where the grants
-- refuse update, delete and truncate before a trigger runs. Only a test in
-- the database itself proves the triggers hold on their own, as for
-- audit_events (TASK-006 review, note 1). Runs with `pnpm test:db`;
-- everything rolls back.
begin;

select plan(26);

-- Fixtures ------------------------------------------------------------------------

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-000000220a01', 'Pgtap Checks', 'pgtap-checks'),
  ('00000000-0000-4000-8000-000000220a02', 'Pgtap Checks Other', 'pgtap-checks-other');

-- The disclosure version trigger refuses an insert with no signed-in user.
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

select pg_temp.sign_in_as('00000000-0000-4000-8000-000000220e01');

insert into public.ai_systems (id, organization_id, name, system_type)
values
  ('00000000-0000-4000-8000-000000220b01', '00000000-0000-4000-8000-000000220a01', 'Checked', 'chatbot'),
  ('00000000-0000-4000-8000-000000220b02', '00000000-0000-4000-8000-000000220a02', 'Theirs', 'chatbot');

insert into public.deployments (id, organization_id, ai_system_id, hostname)
values
  ('00000000-0000-4000-8000-000000220c01', '00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220b01', 'checked.example.com'),
  ('00000000-0000-4000-8000-000000220c02', '00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220b01', 'second.example.com'),
  ('00000000-0000-4000-8000-000000220c03', '00000000-0000-4000-8000-000000220a02', '00000000-0000-4000-8000-000000220b02', 'theirs.example.com');

insert into public.disclosures (id, organization_id, ai_system_id, message, language)
values
  ('00000000-0000-4000-8000-000000220d01', '00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220b01', 'You are interacting with an AI system.', 'en'),
  ('00000000-0000-4000-8000-000000220d02', '00000000-0000-4000-8000-000000220a02', '00000000-0000-4000-8000-000000220b02', 'Theirs, also an AI system.', 'en');

-- The outcome columns -------------------------------------------------------------

insert into public.verification_checks
  (organization_id, deployment_id, disclosure_id, status, check_window, checked_at,
   http_status, widget_detected, disclosure_version)
values
  ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c01',
   '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01', '2000-01-01',
   200, true, 1);

select ok(
  (select checked_at > now() - interval '1 minute'
   from public.verification_checks
   where deployment_id = '00000000-0000-4000-8000-000000220c01'),
  'checked_at is the database''s, not the writer''s'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window, failure_code)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01', 'DNS_ERROR') $$,
  '23514',
  null,
  'a success cannot carry a failure code'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'failure', '2000-01-01') $$,
  '23514',
  null,
  'a failure must carry a reason'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window, failure_code)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'failure', '2000-01-01', 'SUCCESS') $$,
  '23514',
  null,
  'SUCCESS is not a stored failure code'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window, failure_code)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'failure', '2000-01-01', 'MADE_UP') $$,
  '23514',
  null,
  'an unknown failure code is refused'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'checked', '2000-01-01') $$,
  '23514',
  null,
  'a status outside success and failure is refused'
);

-- Idempotency ---------------------------------------------------------------------

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c01',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01') $$,
  '23505',
  null,
  'a second check for one deployment and window is refused'
);

select lives_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c01',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-02') $$,
  'the next window is a new row'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'success', '2999-01-01') $$,
  '23514',
  null,
  'a window that begins after the check is refused'
);

-- The tenant binding --------------------------------------------------------------

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c03',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01') $$,
  '23503',
  null,
  'a check cannot name another organization''s deployment'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d02', 'success', '2000-01-01') $$,
  '23503',
  null,
  'a check cannot name another organization''s disclosure'
);

-- The observation columns ---------------------------------------------------------

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window, http_status)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01', 0) $$,
  '23514',
  null,
  'an http status outside 100-599 is refused'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window, disclosure_version)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01', 0) $$,
  '23514',
  null,
  'an observed version below 1 is refused'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window, metadata)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01', '[]'::jsonb) $$,
  '23514',
  null,
  'metadata that is not an object is refused'
);

-- The reserved integrity columns (README §20) --------------------------------------

select lives_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window,
        payload_hash, previous_record_hash)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-01',
             repeat('a', 64), repeat('b', 64)) $$,
  'a 64-character hex digest is accepted in both hash columns'
);

select throws_ok(
  $$ insert into public.verification_checks
       (organization_id, deployment_id, disclosure_id, status, check_window, payload_hash)
     values ('00000000-0000-4000-8000-000000220a01', '00000000-0000-4000-8000-000000220c02',
             '00000000-0000-4000-8000-000000220d01', 'success', '2000-01-03',
             repeat('A', 64)) $$,
  '23514',
  null,
  'anything but 64 lowercase hex characters is refused'
);

-- Append-only ---------------------------------------------------------------------

select throws_ok(
  $$ update public.verification_checks set status = 'failure'
     where organization_id = '00000000-0000-4000-8000-000000220a01' $$,
  '42501',
  'verification checks are append-only',
  'the table owner cannot update a check'
);

select throws_ok(
  $$ delete from public.verification_checks
     where deployment_id = '00000000-0000-4000-8000-000000220c01' $$,
  '42501',
  'verification checks are append-only',
  'the table owner cannot delete a check directly'
);

select throws_ok(
  $$ truncate public.verification_checks $$,
  '42501',
  'verification checks are append-only',
  'the table owner cannot truncate verification_checks'
);

-- A delete issued from inside some other trigger runs at trigger depth 2,
-- as a cascade does. It must still be refused while the parents exist.
create table pg_temp.cleanup_probe (deployment_id uuid);

create function pg_temp.delete_checks()
returns trigger
language plpgsql
as $$
begin
  delete from public.verification_checks where deployment_id = new.deployment_id;
  return new;
end;
$$;

create trigger cleanup_probe_deletes_checks
  after insert on pg_temp.cleanup_probe
  for each row execute function pg_temp.delete_checks();

select throws_ok(
  $$ insert into pg_temp.cleanup_probe
     values ('00000000-0000-4000-8000-000000220c01') $$,
  '42501',
  'verification checks are append-only',
  'a delete from another trigger is refused while the parents exist'
);

-- Cascades ------------------------------------------------------------------------

-- Neither a deployment nor an AI system is ever deleted on its own: both
-- are archived and their history is kept (README §33). So the organization
-- is the only door, and that is what takes the evidence with it. The
-- trigger above still admits a deployment or disclosure that is gone,
-- because a cascade visits rows in no promised order.
select throws_ok(
  $$ delete from public.deployments
     where id = '00000000-0000-4000-8000-000000220c01' $$,
  '42501', 'deployments are archived, not deleted',
  'a deployment is archived rather than deleted, so its evidence stays'
);

select throws_ok(
  $$ delete from public.ai_systems
     where id = '00000000-0000-4000-8000-000000220b01' $$,
  '42501', 'AI systems are archived, not deleted',
  'and neither is its AI system'
);

select lives_ok(
  $$ delete from public.organizations
     where id = '00000000-0000-4000-8000-000000220a01' $$,
  'deleting the organization is allowed'
);

select is(
  (select count(*)::int from public.verification_checks
   where organization_id = '00000000-0000-4000-8000-000000220a01'),
  0,
  'its checks went with it, by cascade'
);

-- Grants --------------------------------------------------------------------------

select ok(
  has_table_privilege('authenticated', 'public.verification_checks', 'select')
    and not has_table_privilege('authenticated', 'public.verification_checks', 'insert')
    and not has_table_privilege('authenticated', 'public.verification_checks', 'update')
    and not has_table_privilege('authenticated', 'public.verification_checks', 'delete'),
  'a signed-in user reads evidence and writes none'
);

select ok(
  not has_table_privilege('anon', 'public.verification_checks', 'select')
    and has_table_privilege('service_role', 'public.verification_checks', 'insert')
    and not has_table_privilege('service_role', 'public.verification_checks', 'update')
    and not has_table_privilege('service_role', 'public.verification_checks', 'delete'),
  'the internet reads nothing, and the one writer only inserts'
);

select * from finish();
rollback;

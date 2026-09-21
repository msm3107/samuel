-- The append-only trigger on audit_events, tested as the table owner.
--
-- The Vitest suites reach the database through the API, where the grants
-- refuse update, delete and truncate before the trigger runs. So only a test
-- in the database itself proves the trigger holds on its own (TASK-006
-- review, note 1). Runs with `pnpm test:db`; everything rolls back.
begin;

select plan(9);

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-0000000000a1', 'Kept', 'pgtap-audit-kept'),
  ('00000000-0000-4000-8000-0000000000a2', 'Deleted', 'pgtap-audit-deleted');

insert into public.audit_events
  (organization_id, actor_user_id, event_type, entity_type, entity_id, created_at)
values
  (
    '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000b1',
    'organization.created',
    'organization',
    '00000000-0000-4000-8000-0000000000a1',
    '2000-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000000a2',
    '00000000-0000-4000-8000-0000000000b1',
    'organization.created',
    'organization',
    '00000000-0000-4000-8000-0000000000a2',
    '2000-01-01'
  );

select ok(
  (select bool_and(created_at > now() - interval '1 minute')
   from public.audit_events
   where actor_user_id = '00000000-0000-4000-8000-0000000000b1'),
  'created_at is the database''s, not the writer''s'
);

select throws_ok(
  $$ update public.audit_events set metadata = '{"x": 1}'
     where organization_id = '00000000-0000-4000-8000-0000000000a1' $$,
  '42501',
  'audit events are append-only',
  'the table owner cannot update an audit row'
);

select throws_ok(
  $$ delete from public.audit_events
     where organization_id = '00000000-0000-4000-8000-0000000000a1' $$,
  '42501',
  'audit events are append-only',
  'the table owner cannot delete an audit row directly'
);

select throws_ok(
  $$ truncate public.audit_events $$,
  '42501',
  'audit events are append-only',
  'the table owner cannot truncate audit_events'
);

-- A delete issued from inside some other trigger runs at trigger depth 2,
-- like the cascade does. It must still be refused while the organization
-- exists (review note 2).
create table pg_temp.cleanup_probe (organization_id uuid);

create function pg_temp.delete_audit_rows()
returns trigger
language plpgsql
as $$
begin
  delete from public.audit_events where organization_id = new.organization_id;
  return new;
end;
$$;

create trigger cleanup_probe_deletes_audit_rows
  after insert on pg_temp.cleanup_probe
  for each row execute function pg_temp.delete_audit_rows();

select throws_ok(
  $$ insert into pg_temp.cleanup_probe
     values ('00000000-0000-4000-8000-0000000000a1') $$,
  '42501',
  'audit events are append-only',
  'a delete from another trigger is refused while the organization exists'
);

select is(
  (select count(*)::int from public.audit_events
   where organization_id = '00000000-0000-4000-8000-0000000000a1'),
  1,
  'the kept organization''s audit row is untouched'
);

select lives_ok(
  $$ delete from public.organizations
     where id = '00000000-0000-4000-8000-0000000000a2' $$,
  'deleting an organization is allowed'
);

select is(
  (select count(*)::int from public.audit_events
   where organization_id = '00000000-0000-4000-8000-0000000000a2'),
  0,
  'its audit rows go with it, by cascade'
);

select is(
  (select count(*)::int from public.audit_events
   where organization_id = '00000000-0000-4000-8000-0000000000a1'),
  1,
  'another organization''s audit rows are not touched by that cascade'
);

select * from finish();

rollback;

-- public.verification_queue (TASK-025): the scheduler's queue.
--
-- This function decides which customers get checked. Its where clause is
-- therefore the thing to test, and it is tested here rather than through the
-- API for the same reason the constraints are: the conditions are the
-- database's, and a Vitest suite can only observe them through one caller.
--
-- Two properties matter most. It must return exactly the deployments a notice
-- would render for — the same five conditions `public.public_disclosure`
-- applies, because a deployment the widget shows nothing for has nothing to
-- verify. And it must exclude what has already been checked in the window,
-- because that absence is the whole of the scheduler's state.
--
-- Runs with `pnpm test:db`; everything rolls back.
begin;

select plan(14);

-- Fixtures ------------------------------------------------------------------------

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-000000250a01', 'Pgtap Queue', 'pgtap-queue'),
  ('00000000-0000-4000-8000-000000250a02', 'Pgtap Queue Gone', 'pgtap-queue-gone');

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

select pg_temp.sign_in_as('00000000-0000-4000-8000-000000250e01');

insert into public.ai_systems (id, organization_id, name, system_type)
values
  -- Live, with a notice.
  ('00000000-0000-4000-8000-000000250b01', '00000000-0000-4000-8000-000000250a01', 'Queued', 'chatbot'),
  -- Archived: nothing of its renders, so nothing of its is checked.
  ('00000000-0000-4000-8000-000000250b02', '00000000-0000-4000-8000-000000250a01', 'Archived', 'chatbot'),
  -- Its notice is turned off.
  ('00000000-0000-4000-8000-000000250b03', '00000000-0000-4000-8000-000000250a01', 'Silent', 'chatbot'),
  -- It has no disclosure at all.
  ('00000000-0000-4000-8000-000000250b04', '00000000-0000-4000-8000-000000250a01', 'Undisclosed', 'chatbot'),
  -- In an organization that is deleted below.
  ('00000000-0000-4000-8000-000000250b05', '00000000-0000-4000-8000-000000250a02', 'Orphan', 'chatbot');

insert into public.deployments (id, organization_id, ai_system_id, hostname, created_at)
values
  ('00000000-0000-4000-8000-000000250c01', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b01', 'first.example.com', '2020-01-01'),
  ('00000000-0000-4000-8000-000000250c02', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b01', 'second.example.com', '2020-01-02'),
  -- Archived deployment of a live system.
  ('00000000-0000-4000-8000-000000250c03', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b01', 'archived.example.com', '2020-01-03'),
  -- Live deployment of an archived system.
  ('00000000-0000-4000-8000-000000250c04', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b02', 'archived-system.example.com', '2020-01-04'),
  -- Its notice is turned off.
  ('00000000-0000-4000-8000-000000250c05', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b03', 'silent.example.com', '2020-01-05'),
  -- Its system has published nothing.
  ('00000000-0000-4000-8000-000000250c06', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b04', 'undisclosed.example.com', '2020-01-06'),
  -- Its organization is deleted.
  ('00000000-0000-4000-8000-000000250c07', '00000000-0000-4000-8000-000000250a02',
   '00000000-0000-4000-8000-000000250b05', 'orphan.example.com', '2020-01-07');

insert into public.disclosures (id, organization_id, ai_system_id, message, language)
values
  ('00000000-0000-4000-8000-000000250d01', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b01', 'Version one, superseded below.', 'en'),
  ('00000000-0000-4000-8000-000000250d03', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b02', 'An archived system''s notice.', 'en'),
  ('00000000-0000-4000-8000-000000250d04', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b03', 'Turned off below.', 'en'),
  ('00000000-0000-4000-8000-000000250d05', '00000000-0000-4000-8000-000000250a02',
   '00000000-0000-4000-8000-000000250b05', 'An orphan''s notice.', 'en');

-- A second version of the live system's notice: the current one.
insert into public.disclosures (id, organization_id, ai_system_id, message, language)
values
  ('00000000-0000-4000-8000-000000250d02', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b01', 'Version two, the current notice.', 'en');

-- Archived only now: a trigger refuses a disclosure for an archived AI system,
-- so the fixtures publish first and then archive, which is also the order a
-- customer's own actions take.
update public.deployments set status = 'archived'
where id = '00000000-0000-4000-8000-000000250c03';

update public.ai_systems set status = 'archived'
where id = '00000000-0000-4000-8000-000000250b02';

-- Turning a notice off is publishing a new version with `enabled = false`: a
-- published version is immutable, so there is no update to make. It is also the
-- stronger fixture, because it proves the queue reads the *current* version's
-- flag rather than any enabled version the system ever had.
insert into public.disclosures (id, organization_id, ai_system_id, message, language, enabled)
values
  ('00000000-0000-4000-8000-000000250d06', '00000000-0000-4000-8000-000000250a01',
   '00000000-0000-4000-8000-000000250b03', 'Turned off in this version.', 'en', false);

update public.organizations set deleted_at = now()
where id = '00000000-0000-4000-8000-000000250a02';

-- Which deployments are due --------------------------------------------------------

select set_eq(
  $$ select hostname from public.verification_queue('2026-09-27'::timestamptz, 100) $$,
  array['first.example.com', 'second.example.com'],
  'only deployments a notice would render for are due'
);

select is(
  (select count(*)::int from public.verification_queue('2026-09-27'::timestamptz, 100)
   where hostname = 'archived.example.com'),
  0,
  'an archived deployment is not due'
);

select is(
  (select count(*)::int from public.verification_queue('2026-09-27'::timestamptz, 100)
   where hostname = 'archived-system.example.com'),
  0,
  'a deployment of an archived AI system is not due'
);

select is(
  (select count(*)::int from public.verification_queue('2026-09-27'::timestamptz, 100)
   where hostname = 'silent.example.com'),
  0,
  'a deployment whose current notice is turned off is not due'
);

select is(
  (select count(*)::int from public.verification_queue('2026-09-27'::timestamptz, 100)
   where hostname = 'undisclosed.example.com'),
  0,
  'a deployment whose system has published nothing is not due'
);

select is(
  (select count(*)::int from public.verification_queue('2026-09-27'::timestamptz, 100)
   where hostname = 'orphan.example.com'),
  0,
  'a deleted organization''s deployment is not due'
);

-- The check is against the current version, which is what the widget serves.
select is(
  (select disclosure_id from public.verification_queue('2026-09-27'::timestamptz, 100)
   where hostname = 'first.example.com'),
  '00000000-0000-4000-8000-000000250d02'::uuid,
  'a due deployment names the current disclosure version, not an older one'
);

select is(
  (select public_id from public.verification_queue('2026-09-27'::timestamptz, 100)
   where hostname = 'first.example.com'),
  (select public_id from public.deployments
   where id = '00000000-0000-4000-8000-000000250c01'),
  'the queue carries the identifier the verifier looks for on the page'
);

-- The queue is the absence of a row ------------------------------------------------

insert into public.verification_checks
  (organization_id, deployment_id, disclosure_id, status, check_window,
   http_status, widget_detected)
values
  ('00000000-0000-4000-8000-000000250a01', '00000000-0000-4000-8000-000000250c01',
   '00000000-0000-4000-8000-000000250d02', 'success', '2026-09-27', 200, true);

select set_eq(
  $$ select hostname from public.verification_queue('2026-09-27'::timestamptz, 100) $$,
  array['second.example.com'],
  'a deployment already checked in the window is no longer due'
);

select set_eq(
  $$ select hostname from public.verification_queue('2026-09-28'::timestamptz, 100) $$,
  array['first.example.com', 'second.example.com'],
  'and it is due again in the next window'
);

select is(
  (select count(*)::int from public.verification_queue('2026-09-27'::timestamptz, 0)),
  0,
  'a limit of zero asks for nothing'
);

select is(
  (select count(*)::int from public.verification_queue('2026-09-27'::timestamptz, -5)),
  0,
  'a negative limit is not an error, and asks for nothing'
);

-- Who may call it ------------------------------------------------------------------

select ok(
  has_function_privilege(
    'service_role',
    'public.verification_queue(timestamptz, integer)',
    'execute'
  ),
  'the service role may read the queue'
);

-- It crosses every tenant boundary by design, which is exactly why no
-- user-facing role may call it: a member could otherwise enumerate other
-- organizations' deployments and hostnames.
select ok(
  not has_function_privilege(
    'authenticated',
    'public.verification_queue(timestamptz, integer)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.verification_queue(timestamptz, integer)',
    'execute'
  ),
  'no signed-in or anonymous caller may read the queue'
);

select * from finish();
rollback;

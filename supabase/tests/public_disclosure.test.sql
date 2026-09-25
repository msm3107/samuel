-- public.public_disclosure (TASK-019): the one thing an unauthenticated
-- caller may do. The rules about which deployments resolve live in SQL, so
-- they are tested in SQL: one case that shows, six that do not, and the
-- grants that decide who may ask at all.
--
-- The route is TASK-019a's; it can only narrow what this returns, never
-- widen it, so what follows is the whole of the public surface's behaviour.
-- Runs with `pnpm test:db`; everything rolls back.
begin;

select plan(17);

-- Fixtures ------------------------------------------------------------------------

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-000000190a01', 'Pgtap Public Disclosure', 'pgtap-public-disclosure'),
  ('00000000-0000-4000-8000-000000190a02', 'Pgtap Public Disclosure Gone', 'pgtap-public-disclosure-gone');

-- The version trigger refuses an insert with no signed-in user, so the
-- claim is set; the role stays the table owner, which bypasses RLS. This
-- file is about the function's own where clause, not about RLS.
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

select pg_temp.sign_in_as('00000000-0000-4000-8000-000000190e01');

insert into public.ai_systems (id, organization_id, name, system_type)
values
  ('00000000-0000-4000-8000-000000190b01', '00000000-0000-4000-8000-000000190a01', 'Shows', 'chatbot'),
  ('00000000-0000-4000-8000-000000190b02', '00000000-0000-4000-8000-000000190a01', 'System Archived', 'chatbot'),
  ('00000000-0000-4000-8000-000000190b03', '00000000-0000-4000-8000-000000190a01', 'Never Published', 'chatbot'),
  ('00000000-0000-4000-8000-000000190b04', '00000000-0000-4000-8000-000000190a01', 'Turned Off', 'chatbot'),
  ('00000000-0000-4000-8000-000000190b05', '00000000-0000-4000-8000-000000190a02', 'Organization Gone', 'chatbot');

insert into public.deployments (id, organization_id, ai_system_id, hostname, status)
values
  ('00000000-0000-4000-8000-000000190c01', '00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b01', 'shows.example.com', 'active'),
  ('00000000-0000-4000-8000-000000190c02', '00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b01', 'archived-deployment.example.com', 'archived'),
  ('00000000-0000-4000-8000-000000190c03', '00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b02', 'archived-system.example.com', 'active'),
  ('00000000-0000-4000-8000-000000190c04', '00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b03', 'never-published.example.com', 'active'),
  ('00000000-0000-4000-8000-000000190c05', '00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b04', 'turned-off.example.com', 'active'),
  ('00000000-0000-4000-8000-000000190c06', '00000000-0000-4000-8000-000000190a02', '00000000-0000-4000-8000-000000190b05', 'organization-gone.example.com', 'active');

-- Two versions on the system that shows, so the assertion below proves the
-- current version is returned and not an older one.
insert into public.disclosures (organization_id, ai_system_id, message, language, enabled)
values
  ('00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b01', 'An older notice.', 'en', true),
  ('00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b01', 'You are interacting with an AI system.', 'pl', true);

insert into public.disclosures (organization_id, ai_system_id, message, language, enabled)
values
  ('00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b02', 'Archived system notice.', 'en', true),
  ('00000000-0000-4000-8000-000000190a02', '00000000-0000-4000-8000-000000190b05', 'Gone organization notice.', 'en', true);

-- An enabled version, then a disabled one above it: the current version is
-- off, and the older enabled one must not stand in for it.
insert into public.disclosures (organization_id, ai_system_id, message, language, enabled)
values
  ('00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b04', 'Was shown once.', 'en', true),
  ('00000000-0000-4000-8000-000000190a01', '00000000-0000-4000-8000-000000190b04', 'No longer shown.', 'en', false);

-- Archived after its notice was published, because nothing is published
-- under an archived system. Archiving a system does not archive its
-- deployments (TASK-011: "the deployment stays as archiving leaves
-- deployments"), so this deployment is active under an archived system --
-- exactly the case the function must refuse on the system's status alone.
update public.ai_systems
set status = 'archived'
where id = '00000000-0000-4000-8000-000000190b02';

create function pg_temp.public_id(p_deployment uuid)
returns text
language sql
as $$
  select public_id from public.deployments where id = p_deployment;
$$;

-- The one case that shows -----------------------------------------------------------

select results_eq(
  format(
    'select version, language, message from public.public_disclosure(%L)',
    pg_temp.public_id('00000000-0000-4000-8000-000000190c01')
  ),
  $$values (2, 'pl'::text, 'You are interacting with an AI system.'::text)$$,
  'an active deployment of an active system resolves to the current version, not an older one'
);

-- The six that do not ---------------------------------------------------------------

select is_empty(
  $$select * from public.public_disclosure('dep_aaaaaaaaaaaaaaaaaaaaaaaaaa')$$,
  'an identifier that names no deployment resolves to nothing'
);

select is_empty(
  format(
    'select * from public.public_disclosure(%L)',
    pg_temp.public_id('00000000-0000-4000-8000-000000190c02')
  ),
  'an archived deployment resolves to nothing'
);

select is_empty(
  format(
    'select * from public.public_disclosure(%L)',
    pg_temp.public_id('00000000-0000-4000-8000-000000190c03')
  ),
  'a deployment of an archived AI system resolves to nothing'
);

select is_empty(
  format(
    'select * from public.public_disclosure(%L)',
    pg_temp.public_id('00000000-0000-4000-8000-000000190c04')
  ),
  'a system that has never published resolves to nothing'
);

select is_empty(
  format(
    'select * from public.public_disclosure(%L)',
    pg_temp.public_id('00000000-0000-4000-8000-000000190c05')
  ),
  'a current version that is turned off resolves to nothing, and no older enabled version stands in for it'
);

update public.organizations
set deleted_at = now()
where id = '00000000-0000-4000-8000-000000190a02';

select is_empty(
  format(
    'select * from public.public_disclosure(%L)',
    pg_temp.public_id('00000000-0000-4000-8000-000000190c06')
  ),
  'a soft-deleted organization resolves to nothing'
);

-- An identifier is fixed for a deployment's life ------------------------------------

-- Archiving revokes an identifier; restoring the same row gives it back,
-- because public_id never changes (TASK-014, owner 2026-09-22). Only
-- registering the hostname again creates a new row with a new one, so the
-- function must read the status at call time rather than treat an archived
-- identifier as dead forever.
update public.deployments
set status = 'active'
where id = '00000000-0000-4000-8000-000000190c02';

select results_eq(
  format(
    'select version from public.public_disclosure(%L)',
    pg_temp.public_id('00000000-0000-4000-8000-000000190c02')
  ),
  $$values (2)$$,
  'a restored deployment resolves again, under the same identifier'
);

-- The function returns three columns and no identifier ------------------------------

select is(
  (
    select array_agg(p.proargnames[i] order by i)
    from pg_proc p,
      generate_subscripts(p.proargnames, 1) as i
    where p.oid = 'public.public_disclosure(text)'::regprocedure
      and p.proargmodes[i] = 't'
  ),
  array['version', 'language', 'message'],
  'the function returns exactly version, language and message: no identifier, organization, hostname, time or author'
);

-- Who may ask ------------------------------------------------------------------------

select ok(
  has_function_privilege('anon', 'public.public_disclosure(text)', 'execute'),
  'anon may call the public lookup'
);

select ok(
  has_function_privilege('authenticated', 'public.public_disclosure(text)', 'execute'),
  'a signed-in visitor to a customer site is served the same way'
);

select ok(
  not has_table_privilege('anon', 'public.deployments', 'select'),
  'anon still cannot select from deployments'
);

select ok(
  not has_table_privilege('anon', 'public.ai_systems', 'select'),
  'anon still cannot select from ai_systems'
);

select ok(
  not has_table_privilege('anon', 'public.disclosures', 'select'),
  'anon still cannot select from disclosures'
);

select ok(
  not has_table_privilege('anon', 'public.organizations', 'select'),
  'anon still cannot select from organizations'
);

select ok(
  (
    select p.provolatile = 's' and p.prosecdef
    from pg_proc p
    where p.oid = 'public.public_disclosure(text)'::regprocedure
  ),
  'the lookup is stable and security definer: it reads, and it never writes'
);

-- The revoke, not only the grants (PR #35 review, note 1). A function is
-- executable by PUBLIC by default, and `create or replace` keeps existing
-- privileges -- but a later task that adds a column to the return type must
-- drop and recreate this function, and the new one starts executable by
-- PUBLIC again. Asserting only who may call would pass straight through
-- that.
--
-- `proacl is not null` is the part that makes this a real test: on a
-- function whose privileges were never touched, proacl is null, aclexplode
-- returns nothing, and the `not exists` below would pass while PUBLIC in
-- fact holds execute by default.
select ok(
  (
    select p.proacl is not null
    from pg_proc p
    where p.oid = 'public.public_disclosure(text)'::regprocedure
  )
  and not exists (
    select 1
    from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.public_disclosure(text)'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  ),
  'PUBLIC holds no execute on the public lookup: exactly three roles do'
);

select * from finish();
rollback;

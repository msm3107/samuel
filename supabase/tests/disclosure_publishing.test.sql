-- public.publish_disclosure and the two rules TASK-017 owed on older tables
-- (AI systems refuse deletes, PR #31 review, note 1; the NFC checks, PR #23
-- review), tested in the database. The Vitest suites cover the function
-- through the route; this file covers what only the database can show:
-- grants, that the visibility check runs before the stale and unchanged
-- checks, and the two older-table rules the migration carries alongside it.
-- Runs with `pnpm test:db`; everything rolls back.
begin;

select plan(31);

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-0000000dd0a1', 'Pgtap Disclosure Publishing', 'pgtap-disclosure-publishing'),
  ('00000000-0000-4000-8000-0000000dd0a2', 'Pgtap Disclosure Publishing Elsewhere', 'pgtap-disclosure-publishing-elsewhere');

-- Sets the JWT claim only; the role stays the table owner, which bypasses
-- RLS, so publish_disclosure's own stale and unchanged logic is tested
-- without RLS in the way (as the version trigger is in disclosures.test.sql).
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

-- Sets the claim and switches to the `authenticated` role, so RLS actually
-- applies: only this combination can show the visibility check running
-- before the stale check (below).
create function pg_temp.act_as_authenticated(p_user_id uuid)
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

select pg_temp.sign_in_as('00000000-0000-4000-8000-0000000dd0e1');

insert into public.ai_systems (id, organization_id, name, system_type)
values
  ('00000000-0000-4000-8000-0000000dd0b1', '00000000-0000-4000-8000-0000000dd0a1', 'Publish Target', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dd0b2', '00000000-0000-4000-8000-0000000dd0a1', 'Invisible To Outsiders', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dd0b3', '00000000-0000-4000-8000-0000000dd0a1', 'Delete Refused', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dd0b5', '00000000-0000-4000-8000-0000000dd0a2', 'Org Cascade', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dd0b6', '00000000-0000-4000-8000-0000000dd0a1', 'Empty System', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dd0b7', '00000000-0000-4000-8000-0000000dd0a1', 'Enabled Differs', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dd0b8', '00000000-0000-4000-8000-0000000dd0a1', 'Language Differs', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dd0b9', '00000000-0000-4000-8000-0000000dd0a1', 'Message Differs', 'chatbot');

create function pg_temp.publish(
  p_message text,
  p_expected_version integer,
  p_system uuid default '00000000-0000-4000-8000-0000000dd0b1',
  p_organization uuid default '00000000-0000-4000-8000-0000000dd0a1',
  p_language text default 'en',
  p_enabled boolean default true
)
returns public.disclosures
language sql
as $$
  select public.publish_disclosure(
    p_organization, p_system, p_message, p_language, p_enabled, p_expected_version
  );
$$;

-- Captures the SQLSTATE and hint of a refused publish, the way
-- disclosures.test.sql's archived_refusal_hint() does for the trigger.
create function pg_temp.publish_refusal(
  p_message text,
  p_expected_version integer,
  p_system uuid default '00000000-0000-4000-8000-0000000dd0b1',
  p_organization uuid default '00000000-0000-4000-8000-0000000dd0a1',
  out code text,
  out hint text
)
language plpgsql
as $$
begin
  perform pg_temp.publish(p_message, p_expected_version, p_system, p_organization);
  code := null;
  hint := null;
exception when others then
  get stacked diagnostics code = returned_sqlstate, hint = pg_exception_hint;
end;
$$;

-- Grants (owner, 2026-09-22, decision 1) -------------------------------------------

select ok(
  has_function_privilege(
    'authenticated',
    'public.publish_disclosure(uuid, uuid, text, text, boolean, integer)',
    'execute'
  ),
  'a signed-in user may call publish_disclosure'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.publish_disclosure(uuid, uuid, text, text, boolean, integer)',
    'execute'
  ),
  'the anon role may not'
);
select ok(
  not has_function_privilege(
    'public',
    'public.publish_disclosure(uuid, uuid, text, text, boolean, integer)',
    'execute'
  ),
  'public may not, so no future role inherits it by default'
);

-- A first publish, to have a current version to be stale or unchanged against --

select lives_ok(
  $$ select pg_temp.publish('First on the target.', null) $$,
  'expectedVersion null with no current version publishes v1'
);

-- The stale check (owner, decision 2) ------------------------------------------

select is(
  (select code from pg_temp.publish_refusal('Stale with null.', null)),
  'PT409',
  'expectedVersion null is stale once the system has a version'
);
select is(
  (select hint from pg_temp.publish_refusal('Stale with null, again.', null)),
  'disclosure_changed',
  'the stale refusal carries the fixed hint disclosure_changed'
);
select is(
  (select code from pg_temp.publish_refusal(
     'Expects one on an empty system.', 1,
     '00000000-0000-4000-8000-0000000dd0b6')),
  'PT409',
  'a numbered expectedVersion is stale when the system has no version yet'
);
select is(
  (select hint from pg_temp.publish_refusal(
     'Expects one on an empty system, again.', 1,
     '00000000-0000-4000-8000-0000000dd0b6')),
  'disclosure_changed',
  'the same fixed hint when the system has no version yet'
);

-- The unchanged check, via the function and via a direct insert (owner, decision 4) --

select is(
  (select code from pg_temp.publish_refusal('First on the target.', 1)),
  'PT409',
  'a publish identical to the current version is refused'
);
select is(
  (select hint from pg_temp.publish_refusal('First on the target.', 1)),
  'disclosure_unchanged',
  'the unchanged refusal carries the fixed hint disclosure_unchanged'
);
select throws_ok(
  $$ insert into public.disclosures (organization_id, ai_system_id, message, language, enabled)
     values ('00000000-0000-4000-8000-0000000dd0a1', '00000000-0000-4000-8000-0000000dd0b1',
             'First on the target.', 'en', true) $$,
  'PT409', 'the disclosure is unchanged',
  'a direct insert identical to the current version is refused too, by the table''s own trigger'
);

-- The unchanged check compares message, language and enabled each: changing
-- only one of the three is not "unchanged", and the publish succeeds.
select lives_ok(
  $$ select pg_temp.publish(
       'Same text, same language.', null,
       '00000000-0000-4000-8000-0000000dd0b7') $$,
  'seeds a baseline for the enabled-only difference'
);
select lives_ok(
  $$ select pg_temp.publish(
       'Same text, same language.', 1,
       '00000000-0000-4000-8000-0000000dd0b7', '00000000-0000-4000-8000-0000000dd0a1',
       'en', false) $$,
  'enabled alone differing is not unchanged'
);
select lives_ok(
  $$ select pg_temp.publish(
       'Same text, same enabled.', null,
       '00000000-0000-4000-8000-0000000dd0b8') $$,
  'seeds a baseline for the language-only difference'
);
select lives_ok(
  $$ select pg_temp.publish(
       'Same text, same enabled.', 1,
       '00000000-0000-4000-8000-0000000dd0b8', '00000000-0000-4000-8000-0000000dd0a1',
       'fr') $$,
  'language alone differing is not unchanged'
);
select lives_ok(
  $$ select pg_temp.publish(
       'Original message.', null,
       '00000000-0000-4000-8000-0000000dd0b9') $$,
  'seeds a baseline for the message-only difference'
);
select lives_ok(
  $$ select pg_temp.publish(
       'Different message.', 1,
       '00000000-0000-4000-8000-0000000dd0b9') $$,
  'message alone differing is not unchanged'
);

-- Visibility first (owner, PR #31 review, note 2 in the migration) -------------

select pg_temp.act_as_authenticated('00000000-0000-4000-8000-0000000dd0e2');

select throws_ok(
  $$ select pg_temp.publish(
       'Cannot see this system.', null,
       '00000000-0000-4000-8000-0000000dd0b2') $$,
  '23503', null,
  'a caller who is not a member of the organization gets 23503, as if the system did not exist'
);
-- With a version number too: the visibility check comes before the stale
-- check (and before the lock), so a stranger never gets `disclosure_changed`
-- for a system they can't see, nor holds up its organization's publishes.
select throws_ok(
  $$ select pg_temp.publish(
       'Cannot see this system.', 1,
       '00000000-0000-4000-8000-0000000dd0b2') $$,
  '23503', null,
  'a stranger naming a version gets 23503 too, not disclosure_changed'
);

reset role;
select pg_temp.sign_in_as('00000000-0000-4000-8000-0000000dd0e1');

-- AI systems refuse deletes (PR #31 review, note 1) -----------------------------

select throws_ok(
  $$ delete from public.ai_systems where id = '00000000-0000-4000-8000-0000000dd0b3' $$,
  '42501', 'AI systems are archived, not deleted',
  'the table owner cannot delete an AI system while its organization exists'
);
-- A plain truncate never reaches the trigger: deployments and disclosures
-- reference ai_systems by foreign key, so Postgres refuses it outright
-- (0A000) unless cascaded. `cascade` gets past that and into the trigger,
-- which still refuses it.
select throws_ok(
  $$ truncate public.ai_systems cascade $$,
  '42501', 'AI systems are archived, not deleted',
  'the table cannot be truncated, even cascading into what references it'
);
select is(
  (select count(*)::int from public.ai_systems
   where id = '00000000-0000-4000-8000-0000000dd0b3'),
  1,
  'the refused delete left the row'
);

delete from public.organizations where id = '00000000-0000-4000-8000-0000000dd0a2';

select is(
  (select count(*)::int from public.ai_systems
   where organization_id = '00000000-0000-4000-8000-0000000dd0a2'),
  0,
  'deleting the whole organization still takes its AI systems with it'
);

-- The NFC checks (PR #23 review) ------------------------------------------------

select throws_ok(
  $$ insert into public.organizations (name, slug)
     values ('e' || U&'\0301' || ' Org', 'pgtap-nfc-org-refused') $$,
  '23514', null,
  'a non-NFC organization name (e + combining acute) is refused'
);
select lives_ok(
  $$ insert into public.organizations (name, slug)
     values (U&'\00E9' || ' Org', 'pgtap-nfc-org-accepted') $$,
  'the NFC form (precomposed e-acute) is accepted for an organization name'
);
select throws_ok(
  $$ insert into public.ai_systems (organization_id, name, system_type)
     values ('00000000-0000-4000-8000-0000000dd0a1', 'e' || U&'\0301' || ' System', 'chatbot') $$,
  '23514', null,
  'a non-NFC AI system name is refused'
);
select lives_ok(
  $$ insert into public.ai_systems (organization_id, name, system_type)
     values ('00000000-0000-4000-8000-0000000dd0a1', U&'\00E9' || ' System', 'chatbot') $$,
  'the NFC form of an AI system name is accepted'
);
select throws_ok(
  $$ insert into public.ai_systems (organization_id, name, system_type, provider)
     values ('00000000-0000-4000-8000-0000000dd0a1', 'Provider Check Refused', 'chatbot',
             'e' || U&'\0301' || ' Vendor') $$,
  '23514', null,
  'a non-NFC provider is refused'
);
select lives_ok(
  $$ insert into public.ai_systems (organization_id, name, system_type, provider)
     values ('00000000-0000-4000-8000-0000000dd0a1', 'Provider Check Accepted', 'chatbot',
             U&'\00E9' || ' Vendor') $$,
  'the NFC form of a provider is accepted'
);
select throws_ok(
  $$ insert into public.ai_systems (organization_id, name, system_type, description)
     values ('00000000-0000-4000-8000-0000000dd0a1', 'Description Check Refused', 'chatbot',
             'e' || U&'\0301' || ' description') $$,
  '23514', null,
  'a non-NFC description is refused'
);
select lives_ok(
  $$ insert into public.ai_systems (organization_id, name, system_type, description)
     values ('00000000-0000-4000-8000-0000000dd0a1', 'Description Check Accepted', 'chatbot',
             U&'\00E9' || ' description') $$,
  'the NFC form of a description is accepted'
);

select * from finish();

rollback;

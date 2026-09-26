-- public.disclosures (TASK-016): the table, constraints, grants, policies
-- and triggers, tested in the database. Access through RLS is tested
-- against the Data API in
-- tests/security/tenant-isolation/disclosures.supabase.ts, and the
-- database-level guarantees (an update always fails, concurrent publishes
-- get distinct versions) against the real database in
-- tests/integration/database/disclosures.supabase.ts. Runs with
-- `pnpm test:db`; everything rolls back.
begin;

select plan(66);

insert into public.organizations (id, name, slug)
values
  ('00000000-0000-4000-8000-0000000dc0a1', 'Pgtap Disclosures', 'pgtap-disclosures'),
  ('00000000-0000-4000-8000-0000000dc0a2', 'Pgtap Disclosures Elsewhere', 'pgtap-disclosures-elsewhere');

-- Every write below needs a signed-in user: the version trigger refuses a
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

select pg_temp.sign_in_as('00000000-0000-4000-8000-0000000dc0e1');

insert into public.ai_systems (id, organization_id, name, system_type)
values
  ('00000000-0000-4000-8000-0000000dc0b1', '00000000-0000-4000-8000-0000000dc0a1', 'Message Rules', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b2', '00000000-0000-4000-8000-0000000dc0a1', 'Versioning', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b3', '00000000-0000-4000-8000-0000000dc0a1', 'Versioning Other', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b4', '00000000-0000-4000-8000-0000000dc0a1', 'System Cascade', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b5', '00000000-0000-4000-8000-0000000dc0a2', 'Org Cascade', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b6', '00000000-0000-4000-8000-0000000dc0a1', 'Archived', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b7', '00000000-0000-4000-8000-0000000dc0a1', 'Update Delete', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b8', '00000000-0000-4000-8000-0000000dc0a1', 'Languages', 'chatbot'),
  ('00000000-0000-4000-8000-0000000dc0b9', '00000000-0000-4000-8000-0000000dc0a1', 'Audited', 'chatbot');

create function pg_temp.insert_disclosure(
  p_message text,
  p_language text default 'en',
  p_system uuid default '00000000-0000-4000-8000-0000000dc0b1',
  p_organization uuid default '00000000-0000-4000-8000-0000000dc0a1',
  p_enabled boolean default true
)
returns uuid
language sql
as $$
  insert into public.disclosures
    (organization_id, ai_system_id, message, language, enabled)
  values
    (p_organization, p_system, p_message, p_language, p_enabled)
  returning id;
$$;

-- Structure --------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.disclosures'::regclass),
  'row-level security is enabled'
);
select col_not_null('public', 'disclosures', 'organization_id', 'organization_id is required');
select col_not_null('public', 'disclosures', 'ai_system_id', 'ai_system_id is required');
select col_not_null('public', 'disclosures', 'version', 'version is required');
select col_not_null('public', 'disclosures', 'message', 'message is required');
select col_not_null('public', 'disclosures', 'language', 'language is required');
select col_not_null('public', 'disclosures', 'enabled', 'enabled is required');
select col_not_null('public', 'disclosures', 'created_at', 'created_at is required');
select col_not_null('public', 'disclosures', 'created_by', 'created_by is required');
select fk_ok(
  'public', 'disclosures', 'organization_id',
  'public', 'organizations', 'id',
  'organization_id references organizations'
);
select fk_ok(
  'public', 'disclosures', array['organization_id', 'ai_system_id'],
  'public', 'ai_systems', array['organization_id', 'id'],
  'the AI system is referenced together with its organization'
);
select col_is_unique(
  'public', 'disclosures', array['organization_id', 'id'],
  '(organization_id, id) is unique, for verification checks'' composite foreign key'
);
select col_is_unique(
  'public', 'disclosures', array['ai_system_id', 'version'],
  '(ai_system_id, version) is unique, one row per version of a system''s disclosure'
);

-- Grants -------------------------------------------------------------------------

select ok(
  has_table_privilege('authenticated', 'public.disclosures', 'select'),
  'a signed-in user reads disclosures'
);
-- has_table_privilege misses a grant on single columns; this sees both.
select ok(
  not has_any_column_privilege('authenticated', 'public.disclosures', 'update'),
  'a signed-in user has no update, on the table or on any column'
);
select ok(
  not has_table_privilege('authenticated', 'public.disclosures', 'delete'),
  'a signed-in user has no delete'
);
select ok(
  not has_table_privilege('anon', 'public.disclosures', 'select'),
  'the anon role reads nothing'
);
select ok(
  not has_table_privilege('anon', 'public.disclosures', 'insert'),
  'the anon role writes nothing'
);
select ok(
  has_column_privilege('authenticated', 'public.disclosures', 'organization_id', 'insert')
    and has_column_privilege('authenticated', 'public.disclosures', 'ai_system_id', 'insert')
    and has_column_privilege('authenticated', 'public.disclosures', 'message', 'insert')
    and has_column_privilege('authenticated', 'public.disclosures', 'language', 'insert')
    and has_column_privilege('authenticated', 'public.disclosures', 'enabled', 'insert'),
  'a user sets organization_id, ai_system_id, message, language and enabled on insert'
);
select ok(
  not has_column_privilege('authenticated', 'public.disclosures', 'id', 'insert')
    and not has_column_privilege('authenticated', 'public.disclosures', 'version', 'insert')
    and not has_column_privilege('authenticated', 'public.disclosures', 'created_by', 'insert')
    and not has_column_privilege('authenticated', 'public.disclosures', 'created_at', 'insert'),
  'id, version, created_by and created_at are not a user''s to set'
);

-- Policies -------------------------------------------------------------------------

select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'disclosures'
      and policyname = 'disclosures_select_member' and cmd = 'SELECT'
  ),
  'every member of a live organization reads its disclosures'
);
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'disclosures'
      and policyname = 'disclosures_insert_member' and cmd = 'INSERT'
  ),
  'members and up publish disclosures'
);
select policies_are(
  'public', 'disclosures',
  array['disclosures_select_member', 'disclosures_insert_member'],
  'no update or delete policy: a change is a new version'
);

-- The trigger functions are not callable directly -------------------------------

select ok(
  not has_function_privilege('authenticated', 'private.set_disclosure_version()', 'execute')
    and not has_function_privilege('authenticated', 'private.refuse_disclosure_update()', 'execute')
    and not has_function_privilege('authenticated', 'private.refuse_disclosure_delete()', 'execute')
    and not has_function_privilege('authenticated', 'private.refuse_disclosure_truncate()', 'execute')
    and not has_function_privilege('authenticated', 'private.require_active_ai_system_for_disclosure()', 'execute')
    and not has_function_privilege('authenticated', 'private.audit_disclosure_published()', 'execute'),
  'a signed-in user cannot call the trigger functions directly'
);

-- Message rules (owner, 2026-09-22) -----------------------------------------------

select lives_ok(
  $$ select pg_temp.insert_disclosure('A valid one-line notice.') $$,
  'a plain one-line message is accepted'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure('') $$,
  '23514', null, 'an empty message is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(repeat('x', 501)) $$,
  '23514', null, 'a message over 500 characters is refused'
);
select lives_ok(
  $$ select pg_temp.insert_disclosure(repeat('x', 500)) $$,
  'a message of exactly 500 characters is accepted'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(' Leading space.') $$,
  '23514', null, 'a leading space is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure('Trailing space. ') $$,
  '23514', null, 'a trailing space is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(E'Two\nlines.') $$,
  '23514', null, 'a line break is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(E'Bell\x07here.') $$,
  '23514', null, 'a control character other than a line break is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(U&'Right to left\202E override.') $$,
  '23514', null, 'a right-to-left override (U+202E) is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(U&'Zero\200Bwidth.') $$,
  '23514', null, 'a zero-width space (U+200B) is refused'
);
select lives_ok(
  $$ select pg_temp.insert_disclosure(U&'Joined \+01F469\200D\+01F4BB emoji.') $$,
  'a message with an emoji joined by U+200D is accepted'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure('e' || U&'\0301') $$,
  '23514', null, 'a non-NFC-normalized message (e + combining acute) is refused'
);

-- One line (PR #31 review, note 2): the separators [[:cntrl:]] misses, and
-- Unicode spaces at either end, which btrim leaves.
select throws_ok(
  $$ select pg_temp.insert_disclosure(U&'Line\2028separator.') $$,
  '23514', null, 'a line separator (U+2028) is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(U&'Paragraph\2029separator.') $$,
  '23514', null, 'a paragraph separator (U+2029) is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(U&'\00A0Leading no-break space.') $$,
  '23514', null, 'a leading no-break space (U+00A0) is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(U&'Trailing ideographic space.\3000') $$,
  '23514', null, 'a trailing ideographic space (U+3000) is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(U&'Trailing thin space.\2009') $$,
  '23514', null, 'a trailing thin space (U+2009) is refused'
);
select lives_ok(
  $$ select pg_temp.insert_disclosure(U&'Inner no-break\00A0space, 10\202F%.') $$,
  'no-break spaces inside the message are accepted'
);

-- Languages (owner, 2026-09-22: the 24 official EU languages) --------------------

create function pg_temp.count_accepted_languages()
returns integer
language plpgsql
as $$
declare
  v_languages constant text[] := array[
    'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'ga',
    'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk',
    'sl', 'sv'
  ];
  v_language text;
  v_accepted integer := 0;
begin
  foreach v_language in array v_languages loop
    begin
      perform pg_temp.insert_disclosure(
        'Notice in ' || v_language || '.', v_language,
        '00000000-0000-4000-8000-0000000dc0b8'
      );
      v_accepted := v_accepted + 1;
    exception when check_violation then
      null;
    end;
  end loop;
  return v_accepted;
end;
$$;

select is(
  pg_temp.count_accepted_languages(), 24,
  'all 24 official EU languages are accepted'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure('Unsupported language.', 'xx') $$,
  '23514', null, 'a language not on the list is refused'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure('Wrong case.', 'EN') $$,
  '23514', null, 'the language code is case-sensitive: EN is refused'
);

-- Version numbering (owner and implementer, 2026-09-22) ---------------------------

create temporary table dc_v1 on commit drop as
select pg_temp.insert_disclosure('First notice.', 'en', '00000000-0000-4000-8000-0000000dc0b2') as id;

select is(
  (select version from public.disclosures where id = (select id from dc_v1)),
  1,
  'a system''s first published version is 1'
);

create temporary table dc_v2 on commit drop as
select pg_temp.insert_disclosure('Second notice.', 'en', '00000000-0000-4000-8000-0000000dc0b2') as id;

select is(
  (select version from public.disclosures where id = (select id from dc_v2)),
  2,
  'the next version is one more than the highest'
);

create temporary table dc_v3 on commit drop as
select pg_temp.insert_disclosure('Third notice.', 'en', '00000000-0000-4000-8000-0000000dc0b2') as id;

select is(
  (select version from public.disclosures where id = (select id from dc_v3)),
  3,
  'versions keep incrementing'
);

create temporary table dc_other_v1 on commit drop as
select pg_temp.insert_disclosure('Another system''s first notice.', 'en', '00000000-0000-4000-8000-0000000dc0b3') as id;

select is(
  (select version from public.disclosures where id = (select id from dc_other_v1)),
  1,
  'numbering is independent per AI system: another system''s first version is also 1'
);

-- version, created_by and created_at are the database's, whatever is supplied ----

create temporary table dc_override on commit drop as
with ins as (
  insert into public.disclosures
    (organization_id, ai_system_id, message, language, enabled, version, created_by, created_at)
  values
    ('00000000-0000-4000-8000-0000000dc0a1', '00000000-0000-4000-8000-0000000dc0b2',
     'Attempted override.', 'en', true,
     999, '00000000-0000-4000-8000-0000000dc0e2', '2000-01-01T00:00:00Z')
  returning version, created_by, created_at
)
select * from ins;

select is(
  (select version from dc_override), 4,
  'a supplied version is replaced by the database''s next number'
);
select is(
  (select created_by from dc_override)::uuid, '00000000-0000-4000-8000-0000000dc0e1'::uuid,
  'a supplied created_by is replaced by the signed-in user'
);
select ok(
  (select created_at from dc_override) > now() - interval '1 minute',
  'a supplied created_at is replaced by the database''s clock'
);

-- No signed-in user, no publish -----------------------------------------------------

select pg_temp.sign_out();

select throws_ok(
  $$ select pg_temp.insert_disclosure('Nobody''s.') $$,
  '42501', 'disclosures are published by a signed-in user',
  'a publish with no signed-in user, such as the service role, is refused'
);

select pg_temp.sign_in_as('00000000-0000-4000-8000-0000000dc0e1');

-- Immutability: no update, ever ----------------------------------------------------

create temporary table dc_fixed on commit drop as
select pg_temp.insert_disclosure(
  'Fixed message.', 'en', '00000000-0000-4000-8000-0000000dc0b7'
) as id;

select throws_ok(
  $$ update public.disclosures set message = 'Changed.'
     where id = (select id from dc_fixed) $$,
  '42501', 'a published disclosure version is never changed; publish a new version',
  'a published version cannot be updated, even by the table owner'
);
select throws_ok(
  $$ update public.disclosures set enabled = false
     where id = (select id from dc_fixed) $$,
  '42501', 'a published disclosure version is never changed; publish a new version',
  'not even to flip enabled: that is a new version'
);

-- No delete, except with the organization or the AI system -------------------------

select throws_ok(
  $$ delete from public.disclosures where id = (select id from dc_fixed) $$,
  '42501', 'disclosure versions are never deleted',
  'a version cannot be deleted while its organization and AI system still exist'
);
select is(
  (select count(*)::int from public.disclosures where id = (select id from dc_fixed)),
  1,
  'the refused delete left the row'
);

-- Both refusals, for the reason deployments.test.sql gives: since
-- TASK-022 a foreign key from verification_checks stops a bare truncate
-- before any trigger runs, and only `cascade` reaches this table's own.
select throws_ok(
  $$ truncate public.disclosures $$,
  '0A000',
  null,
  'the table cannot be truncated: evidence rows reference it'
);
select throws_ok(
  $$ truncate public.disclosures cascade $$,
  '42501', 'disclosure versions are never deleted',
  'and its own trigger refuses a cascading truncate'
);

-- The AI system cannot be deleted directly, only its organization (TASK-017,
-- PR #31 review, note 1): deleting it would otherwise cascade through its
-- disclosure versions in one statement; now only the organization's own
-- delete does.

create temporary table dc_system_cascade on commit drop as
select pg_temp.insert_disclosure(
  'Will go with its system.', 'en', '00000000-0000-4000-8000-0000000dc0b4'
) as id;

select throws_ok(
  $$ delete from public.ai_systems where id = '00000000-0000-4000-8000-0000000dc0b4' $$,
  '42501', 'AI systems are archived, not deleted',
  'the table owner cannot delete an AI system while its organization exists'
);
select is(
  (select count(*)::int from public.disclosures
   where ai_system_id = '00000000-0000-4000-8000-0000000dc0b4'),
  1,
  'the refused delete left its disclosures in place'
);

-- Deleting the organization cascades -------------------------------------------------

create temporary table dc_org_cascade on commit drop as
select pg_temp.insert_disclosure(
  'Will go with its organization.', 'en',
  '00000000-0000-4000-8000-0000000dc0b5', '00000000-0000-4000-8000-0000000dc0a2'
) as id;

delete from public.organizations where id = '00000000-0000-4000-8000-0000000dc0a2';

select is(
  (select count(*)::int from public.disclosures
   where organization_id = '00000000-0000-4000-8000-0000000dc0a2'),
  0,
  'a hard-deleted organization takes its disclosures with it'
);

-- Archived AI systems (owner, 2026-09-22: as for deployments) ---------------------

update public.ai_systems set status = 'archived'
where id = '00000000-0000-4000-8000-0000000dc0b6';

select throws_ok(
  $$ select pg_temp.insert_disclosure(
       'Cannot publish here.', 'en', '00000000-0000-4000-8000-0000000dc0b6') $$,
  '23514', 'a disclosure''s AI system is archived',
  'nothing is published under an archived AI system'
);
select throws_ok(
  $$ select pg_temp.insert_disclosure(
       'Not even to turn it off.', 'en',
       '00000000-0000-4000-8000-0000000dc0b6', '00000000-0000-4000-8000-0000000dc0a1', false) $$,
  '23514', 'a disclosure''s AI system is archived',
  'not even a version that turns the notice off'
);

-- The refusal carries a fixed hint for the application to match (PR #31
-- review, note 3).
create function pg_temp.archived_refusal_hint()
returns text
language plpgsql
as $$
declare
  v_hint text;
begin
  perform pg_temp.insert_disclosure(
    'Hinted.', 'en',
    '00000000-0000-4000-8000-0000000dc0b6', '00000000-0000-4000-8000-0000000dc0a1');
  return null;
exception when check_violation then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end;
$$;

select is(
  pg_temp.archived_refusal_hint(), 'ai_system_archived',
  'the archived-system refusal carries the fixed hint ai_system_archived'
);

-- Audit --------------------------------------------------------------------------

create temporary table dc_audited on commit drop as
select pg_temp.insert_disclosure(
  'Audited notice.', 'en', '00000000-0000-4000-8000-0000000dc0b9'
) as id;

select results_eq(
  $$ select event_type, entity_type, metadata, actor_user_id
     from public.audit_events
     where entity_id = (select id from dc_audited) $$,
  $$ values (
       'disclosure.published'::text, 'disclosure'::text, '{}'::jsonb,
       '00000000-0000-4000-8000-0000000dc0e1'::uuid
     ) $$,
  'a publish writes disclosure.published, naming the signed-in user as actor, with no metadata'
);

select * from finish();

rollback;

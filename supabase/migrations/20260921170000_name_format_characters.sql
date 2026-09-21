-- Organization names refuse control and Unicode format characters
-- (TASK-008, PR #22 review, finding 2; also PR #21 review, finding 4).
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-21. A right-to-left
-- override or a zero-width space lets a name display as something it is not,
-- in invitation emails, reports and the dashboard. The zero-width joiner
-- (U+200D) stays allowed: emoji and some scripts need it.
--
-- The pattern is the one in 20260921160000_ai_systems.sql: Unicode general
-- category Cf, less U+200D, as of Unicode 16.0.
--
-- Until now only create_organization refused control characters; the table
-- itself did not, so a rename could store one. Both now refuse both.

alter table public.organizations
  add constraint organizations_name_characters_check check (
    name !~ '[[:cntrl:]]'
    and name !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]'
  );

-- The same function, with the format characters added to the name check.
-- `create or replace` keeps its owner, grants and comment.
create or replace function public.create_organization(p_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Top-level routes today, routes the product plan names, and words that
  -- would mislead in a URL. A test keeps this list in step with app/.
  c_reserved constant text[] := array[
    'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'app',
    'assets', 'auth', 'billing', 'blog', 'callback', 'dashboard', 'docs',
    'embed', 'help', 'legal', 'login', 'logout', 'mail', 'new', 'org',
    'organization', 'organizations', 'orgs', 'pricing', 'privacy', 'public',
    'register', 'root', 'security', 'settings', 'sign-in', 'sign-out',
    'sign-up', 'signin', 'signout', 'signup', 'static', 'status', 'support',
    'system', 'terms', 'transparency', 'verify', 'widget', 'www'
  ];
  c_hourly_cap constant integer := 10;
  v_user_id uuid := (select auth.uid());
  v_base text;
  v_slug text;
  v_organization_id uuid;
  v_membership_id uuid;
begin
  if v_user_id is null then
    raise exception 'a signed-in user is required'
      using errcode = '42501';
  end if;

  -- The table's own CHECK says the same; refusing here first gives one
  -- error code for every unacceptable name. Control and format characters
  -- are refused too: a name is shown in the dashboard, emails and reports.
  if p_name is null
    or char_length(p_name) not between 1 and 120
    or p_name <> btrim(p_name)
    or p_name ~ '[[:cntrl:]]'
    or p_name ~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f]' then
    raise exception 'the organization name is not acceptable'
      using errcode = '22023';
  end if;

  -- One creation at a time per user, so concurrent calls cannot all pass the
  -- count below. Other users are not held up.
  perform pg_advisory_xact_lock(
    hashtextextended('public.create_organization:' || v_user_id::text, 0)
  );

  if (
    select count(*)
    from public.audit_events
    where actor_user_id = v_user_id
      and event_type = 'organization.created'
      and created_at > now() - interval '1 hour'
  ) >= c_hourly_cap then
    raise exception 'organization creation limit reached'
      using errcode = 'PT429';
  end if;

  -- The slug: lowercase ASCII letters and digits joined by single hyphens.
  -- Accents are dropped (NFKD, then the combining marks removed), and the
  -- letters that do not decompose that way are mapped by hand.
  v_base := lower(p_name);
  v_base := replace(replace(replace(replace(
    v_base, 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'), 'þ', 'th');
  v_base := translate(v_base, 'łđøħı', 'ldohi');
  v_base := normalize(v_base, nfkd);
  v_base := regexp_replace(v_base, '[̀-ͯ]', '', 'g');
  v_base := btrim(regexp_replace(v_base, '[^a-z0-9]+', '-', 'g'), '-');
  -- Room for a seven-character suffix under the table's 63.
  v_base := rtrim(left(v_base, 50), '-');
  if v_base = '' then
    v_base := 'org';
  end if;

  -- The unique index decides, not a read beforehand: a concurrent creation
  -- with the same base waits for this one and then takes a suffix.
  for v_attempt in 1..8 loop
    if v_attempt = 1
      and char_length(v_base) >= 3
      and not (v_base = any (c_reserved)) then
      v_slug := v_base;
    else
      v_slug := v_base || '-'
        || left(replace(gen_random_uuid()::text, '-', ''), 6);
    end if;

    insert into public.organizations (name, slug)
    values (p_name, v_slug)
    on conflict (slug) do nothing
    returning id into v_organization_id;

    exit when v_organization_id is not null;
  end loop;

  if v_organization_id is null then
    raise exception 'no free slug was found'
      using errcode = '23505';
  end if;

  insert into public.memberships (organization_id, user_id, role)
  values (v_organization_id, v_user_id, 'owner')
  returning id into v_membership_id;

  -- The same shapes features/organizations/audit/audit-events.ts validates;
  -- a test reads these rows back through its schemas.
  insert into public.audit_events
    (organization_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values
    (
      v_organization_id, v_user_id, 'organization.created', 'organization',
      v_organization_id, '{}'::jsonb
    ),
    (
      v_organization_id, v_user_id, 'member.added', 'membership',
      v_membership_id, jsonb_build_object('role', 'owner')
    );

  return jsonb_build_object(
    'id', v_organization_id,
    'name', p_name,
    'slug', v_slug
  );
end;
$$;

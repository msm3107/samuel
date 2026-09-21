-- Creating an organization (TASK-007): the organization, its owner
-- membership and both audit events, in one transaction.
--
-- The Data API runs one statement per request, so the four inserts live in a
-- function. It runs as the signed-in user's own call: the owner is
-- `auth.uid()`, the subject of the JWT Supabase Auth signed, never an
-- argument. The only thing the caller chooses is the name.
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-21:
--   * The slug is derived from the name, never chosen by the caller. When it
--     is taken, or reserved, a random suffix is added in the same
--     transaction, so no caller is ever told "taken" and nobody can probe
--     which organizations exist (README §8).
--   * Words the application uses, or may use, as routes are reserved.
--   * One user creates at most 10 organizations an hour. The function is
--     callable directly through the Data API, not only through the route, so
--     the cap lives here.
--   * The audit rows are written here, not by the application after the
--     fact: the event that establishes ownership can never go missing.
--
-- Errors, each a stable SQLSTATE the application maps:
--   42501  no signed-in user
--   22023  the name is not acceptable
--   PT429  the hourly cap is reached (PostgREST answers with HTTP 429)
--   23505  no free slug after several attempts, which should never happen

create function public.create_organization(p_name text)
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
  -- error code for every unacceptable name. Control characters are refused
  -- too: a name is shown in the dashboard, emails and reports.
  if p_name is null
    or char_length(p_name) not between 1 and 120
    or p_name <> btrim(p_name)
    or p_name ~ '[[:cntrl:]]' then
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
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.user_id = v_user_id
      and m.role = 'owner'
      and o.created_at > now() - interval '1 hour'
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

comment on function public.create_organization(text) is
  'Creates an organization owned by the signed-in user, with its audit events. The only way to create one.';

-- Supabase grants execute on new public functions to anon and authenticated.
-- Only a signed-in user may call this; the service role has no user to own
-- the organization.
revoke all on function public.create_organization(text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_organization(text) to authenticated;

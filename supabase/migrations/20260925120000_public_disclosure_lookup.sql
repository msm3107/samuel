-- TASK-019: the one thing an unauthenticated caller may do — turn a public
-- deployment identifier into the notice that deployment should show.
--
-- Decided by Mikołaj Smoliniec (project owner), 2026-09-25:
--   - A `security definer` function granted to `anon`, not the service-role
--     client in the route. The anon key can do exactly one thing here and
--     see exactly three columns, and the rules about which deployments
--     resolve live in SQL rather than in an application that could forget
--     them. No service-role client touches the one endpoint the whole
--     internet can call.
--   - `learn_more_url` is not returned: no column stores it and no screen
--     can set it. A later task adds the column, the editor field and the
--     widget's link together.
--   - One identical answer for every reason there is nothing to show. Six
--     different causes produce one empty result, so this is no oracle for
--     which deployments exist or what state a customer's account is in.
--
-- A public identifier names what to render. It is never authorization
-- (README §67): everything this returns is meant to be read by anyone who
-- visits the customer's site, and nothing else is returned at all.
--
-- The route that calls this is TASK-019a, in the pull request after this
-- one: a migration adding a function the application reads ships before the
-- code that reads it.

create function public.public_disclosure(p_public_id text)
returns table (
  version integer,
  language text,
  message text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    d.version,
    d.language,
    d.message
  from public.deployments dep
    join public.organizations o
      on o.id = dep.organization_id
    join public.ai_systems s
      on s.organization_id = dep.organization_id
     and s.id = dep.ai_system_id
    join public.disclosures d
      on d.organization_id = dep.organization_id
     and d.ai_system_id = dep.ai_system_id
  where dep.public_id = p_public_id
    -- Every condition is here rather than in the application: a row comes
    -- back only when all of them hold.
    and dep.status = 'active'
    and s.status = 'active'
    and o.deleted_at is null
    -- The current version is the system's highest, through
    -- disclosures_ai_system_id_version_key, the index TASK-016 made for
    -- this. `enabled` is required *of that row*: a notice turned off is
    -- turned off, never replaced by an older one that was on.
    and d.version = (
      select max(d2.version)
      from public.disclosures d2
      -- The organization is written out rather than left to the primary
      -- key (PR #35 review, note 2). It is redundant today: ai_systems.id
      -- is unique, and the composite foreign key forces a disclosure's
      -- organization to agree with its system's. This is the one function
      -- in the schema that bypasses RLS, so its tenant binding is stated
      -- here rather than resting on a fact stated elsewhere. It changes no
      -- plan: (ai_system_id, version) is still the index, and this filters
      -- rows already fetched.
      where d2.organization_id = dep.organization_id
        and d2.ai_system_id = dep.ai_system_id
    )
    and d.enabled;
$$;

-- A function is executable by `public` by default, and a later grant does
-- not take that away, so `public` is revoked first. `authenticated` is
-- granted too: a visitor to a customer's site who happens to hold a session
-- for this application is served the same as anyone else, rather than
-- failing because of a cookie that has nothing to do with the request.
revoke all on function public.public_disclosure(text) from public;
grant execute on function public.public_disclosure(text)
  to anon, authenticated, service_role;

comment on function public.public_disclosure(text) is
  'TASK-019: the current, enabled disclosure for an active deployment of an '
  'active AI system in a live organization, by public deployment identifier. '
  'Returns no row for every other case, without saying which. Security '
  'definer because anon holds no membership; this is the single deliberate '
  'way past the disclosures and deployments policies, and it is narrower '
  'than any policy would be. It is never authorization: a public identifier '
  'names what to render.';

-- The verification queue (TASK-025): which deployments are due for a check in
-- a window. Additive: one function, one grant. No table, column, constraint,
-- policy or grant on an existing object is touched.
--
-- Why a function rather than a query in the application. The predicate for
-- "this deployment has something to show" already exists exactly once, in
-- `public.public_disclosure` (TASK-019): active deployment, active system,
-- live organization, current version, and that version `enabled`. A second
-- copy in a query builder is the drift PR #35 note 2 was written about, and it
-- would drift in the worst direction — the two would disagree about which
-- customers are being checked against what the widget actually serves. The
-- anti-join and the `max(version)` subquery cannot be expressed through
-- PostgREST in any case.
--
-- Why it takes the window. The queue is defined by the absence of a row for
-- that window: `verification_checks` has `unique (deployment_id,
-- check_window)` (TASK-022), so a deployment already checked in this window is
-- not work, and one that is not is. That is the whole of the scheduler's
-- state — no claim column, no lease, no cursor. Two overlapping runs may fetch
-- the same deployment twice; the second insert loses at the constraint, which
-- is wasteful rather than wrong, and it is the failure mode TASK-022 chose this
-- key to have.
--
-- Why `security definer`. It reads four tables the service role can already
-- read, so it grants no new access; it is defined this way so the predicate
-- runs under the function's own search path rather than the caller's, as
-- `public.public_disclosure` does. It is executable by `service_role` alone:
-- `anon` and `authenticated` have no business enumerating other tenants'
-- deployments, and this function deliberately crosses every tenant boundary,
-- which is exactly why no user-facing role may call it.
--
-- What it returns, and what it does not. Enough to fetch and to write the row:
-- the organization, the deployment, the disclosure the check is against, the
-- hostname to fetch, and the public identifier to look for. Not the message,
-- not the version, not the language — the verifier compares an identifier on a
-- page against an identifier, and the less of a customer's notice this carries
-- the less there is to leak into a log.

create function public.verification_queue(
  p_check_window timestamptz,
  p_limit integer
)
returns table (
  organization_id uuid,
  deployment_id uuid,
  disclosure_id uuid,
  hostname text,
  public_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    dep.organization_id,
    dep.id as deployment_id,
    d.id as disclosure_id,
    dep.hostname,
    dep.public_id
  from public.deployments dep
    join public.organizations o
      on o.id = dep.organization_id
    join public.ai_systems s
      on s.organization_id = dep.organization_id
     and s.id = dep.ai_system_id
    join public.disclosures d
      on d.organization_id = dep.organization_id
     and d.ai_system_id = dep.ai_system_id
  where
    -- The same five conditions `public.public_disclosure` applies, in the same
    -- order, because a deployment the widget would show nothing for is a
    -- deployment there is nothing to verify on.
    dep.status = 'active'
    and s.status = 'active'
    and o.deleted_at is null
    and d.version = (
      select max(d2.version)
      from public.disclosures d2
      where d2.organization_id = dep.organization_id
        and d2.ai_system_id = dep.ai_system_id
    )
    and d.enabled
    -- And the one condition that makes this a queue rather than a list.
    and not exists (
      select 1
      from public.verification_checks vc
      where vc.deployment_id = dep.id
        and vc.check_window = p_check_window
    )
  -- Deterministic, so a test can assert an order and a truncated batch is not
  -- a different set each time. The queue drains across the ticks of a window
  -- because every row written removes its deployment from this result, so a
  -- stable order starves nothing.
  order by dep.created_at, dep.id
  limit greatest(p_limit, 0);
$$;

-- A function is executable by `public` by default and a later grant does not
-- take that away, so `public` is revoked first.
revoke all on function public.verification_queue(timestamptz, integer)
  from public, anon, authenticated;

grant execute on function public.verification_queue(timestamptz, integer)
  to service_role;

comment on function public.verification_queue(timestamptz, integer) is
  'Deployments due for a verification check in the given window: those a notice would render for, less those already checked in that window. The scheduler''s entire state (TASK-025). Service role only — it crosses every tenant boundary by design.';

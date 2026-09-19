-- Application rate limits for sign-in (TASK-003c).
--
-- Counters live here, shared by every server instance, and are consumed before
-- any call to Supabase Auth. Keys are HMAC-SHA256 digests computed by the
-- application (lib/security/rate-limit.ts), so no email address or IP address
-- is ever stored.

-- Not exposed through the Data API, which serves `public` and
-- `graphql_public` only. Nothing but the function below touches the table.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.rate_limits (
  -- Lowercase hex HMAC-SHA256: 64 characters, never a raw value.
  key text primary key check (key ~ '^[0-9a-f]{64}$'),
  window_ends_at timestamptz not null,
  hits integer not null check (hits >= 0),
  last_hit_at timestamptz,
  -- The outcome of the most recent call, returned by the same statement that
  -- decided it.
  last_allowed boolean not null
);

-- Defence in depth: even if the schema were exposed, no policy grants access.
alter table private.rate_limits enable row level security;
revoke all on table private.rate_limits
  from public, anon, authenticated, service_role;

comment on table private.rate_limits is
  'Sign-in rate-limit buckets keyed by HMAC. One row per bucket, reset in place when its window ends.';

-- Consumes one hit from a bucket and reports whether it was allowed.
--
-- A hit is allowed when the bucket's window has room (or has ended, which
-- starts a new one) and, when p_min_interval_seconds is positive, the last
-- allowed hit is at least that long ago. A refused hit is not counted.
--
-- One statement decides and records the outcome: `insert ... on conflict do
-- update` locks the row, so two concurrent calls can never both take the last
-- slot.
create function public.consume_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer,
  p_min_interval_seconds integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed boolean;
begin
  if p_limit < 1 or p_window_seconds < 1 or p_min_interval_seconds < 0 then
    raise exception 'invalid rate limit parameters'
      using errcode = '22023';
  end if;

  insert into private.rate_limits as bucket
    (key, window_ends_at, hits, last_hit_at, last_allowed)
  values
    (p_key, now() + make_interval(secs => p_window_seconds), 1, now(), true)
  on conflict (key) do update
  set (window_ends_at, hits, last_hit_at, last_allowed) = (
    select
      case when decision.expired
        then now() + make_interval(secs => p_window_seconds)
        else bucket.window_ends_at
      end,
      case when decision.expired then 0 else bucket.hits end
        + case when decision.allowed then 1 else 0 end,
      case when decision.allowed then now() else bucket.last_hit_at end,
      decision.allowed
    from (
      select
        state.expired,
        state.spaced and (state.expired or bucket.hits < p_limit) as allowed
      from (
        select
          bucket.window_ends_at <= now() as expired,
          p_min_interval_seconds = 0
            or bucket.last_hit_at is null
            or bucket.last_hit_at
              + make_interval(secs => p_min_interval_seconds) <= now()
            as spaced
      ) as state
    ) as decision
  )
  returning bucket.last_allowed into v_allowed;

  return v_allowed;
end;
$$;

comment on function public.consume_rate_limit(text, integer, integer, integer) is
  'Consumes one hit from a sign-in rate-limit bucket. Service role only.';

-- Supabase grants execute on new public functions to anon and authenticated by
-- default. The anon key must not be able to read, fill or exhaust a bucket.
revoke all on function public.consume_rate_limit(text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer, integer)
  to service_role;

-- Daily cleanup. A row holds one window and is reset in place, so the table
-- grows only with distinct keys; rows idle for a day are removed.
create extension if not exists pg_cron;

select cron.schedule(
  'rate-limits-cleanup',
  '17 3 * * *',
  $cleanup$
    delete from private.rate_limits
    where window_ends_at < now() - interval '1 day'
  $cleanup$
);

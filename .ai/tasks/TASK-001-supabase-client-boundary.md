# TASK-001 — Supabase client boundary

## Objective

Establish the three Supabase clients the application needs, kept apart so that
a service-role credential cannot reach a user request path or a client bundle.

## Owner agent

Database

## Dependencies

None beyond Phase 0.

## Allowed files

- lib/database/**
- lib/env/server-env.ts (only to read existing variables)
- tests/unit/database/**
- package.json, pnpm-lock.yaml (for `@supabase/supabase-js` only)

## Forbidden files

- supabase/migrations/**
- features/**
- app/**
- proxy.ts

## Invariants

- Three factories, three files, three names that state their privilege:
  browser client (anon key), server session client (anon key plus the request's
  cookies), service-role client (service key, no user context).
- The service-role module throws if evaluated in a browser runtime, the same
  way `serverEnv()` does.
- Cookie reading and writing is settled here, once, for server components,
  route handlers, and the proxy. No feature re-implements it.
- No factory accepts a user ID, organization ID, or role as an argument.
  Identity comes from cookies; authorization comes later and elsewhere.
- `@supabase/supabase-js` is the only dependency added. Justify it against
  `README.md` §56 in the handoff.

## Acceptance criteria

- A server component, a route handler, and the proxy can each obtain a session
  client that reads the same cookies.
- The service-role client is importable only from server code; a test asserts
  the browser guard throws.
- `pnpm build` output contains no occurrence of the service-role key.
- Typecheck, lint, format, and tests pass.

## Required tests

- unit: the service-role factory throws when `window` is defined
- unit: each factory reads its key from `lib/env`, not from `process.env`
- unit: the browser client is constructed with the anon key, never the service key

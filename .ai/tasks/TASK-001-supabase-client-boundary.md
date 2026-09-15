# TASK-001 — Supabase client boundary

## Objective

Establish the Supabase clients the application needs, kept apart so that a
service-role credential cannot reach a user request path or a client bundle.

## Owner agent

Database

## Dependencies

None beyond Phase 0.

## Allowed files

- lib/database/**
- lib/env/server-env.ts (only to read existing variables)
- tests/unit/database/**
- package.json, pnpm-lock.yaml (for `@supabase/supabase-js`, `@supabase/ssr`,
  and `server-only` only)

## Forbidden files

- supabase/migrations/**
- features/**
- app/**
- proxy.ts

## Invariants

- Three factories, three files, three names that state their privilege: server
  session client (anon key plus the request's cookies, via `next/headers`),
  proxy session client (the same, bound to the proxy's request and response),
  service-role client (service key, no user context).
- No browser client. Sign-in, OAuth initiation, and the code exchange all run
  server-side, so the anon key never enters the client bundle and no
  `NEXT_PUBLIC_SUPABASE_*` variable exists.
- The service-role module imports `server-only` and throws if called in a
  browser runtime, the same way `serverEnv()` does.
- Cookie reading and writing is settled here, once, for server components,
  route handlers, server actions, and the proxy. No feature re-implements it.
- The proxy client never constructs its own `NextResponse`. It applies
  refreshed cookies and cache headers onto the response the proxy already
  built, so the CSP nonce headers survive.
- No factory accepts a user ID, organization ID, or role as an argument.
  Identity comes from cookies; authorization comes later and elsewhere.
- Every added dependency is justified against `README.md` §56 in the handoff.

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
- unit: both session clients are constructed with the anon key, never the
  service key
- unit: the proxy client applies refreshed cookies to the given response
  without replacing its existing headers

## Amendments

- 2026-09-15: the browser client was removed and the proxy session client
  added. A browser client would need `NEXT_PUBLIC_SUPABASE_*` variables and a
  `connect-src` widening in the CSP; nothing in `.ai/PLAN.md` requires calling
  Supabase from the browser. `@supabase/ssr` is required for cookie-backed
  sessions, and `server-only` turns a client import of the service-role module
  into a build failure. Recorded in `.ai/handoffs/TASK-001-handoff.md`.

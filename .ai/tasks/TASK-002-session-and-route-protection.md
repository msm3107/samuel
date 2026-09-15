# TASK-002 — Session resolution and dashboard route protection

## Objective

Give server code one trustworthy answer to "who is making this request", and
close `/dashboard` to anyone unauthenticated.

## Owner agent

Backend

## Dependencies

TASK-001.

## Allowed files

- lib/auth/**
- proxy.ts
- app/(dashboard)/layout.tsx
- tests/integration/auth/**
- tests/security/auth/**

## Forbidden files

- lib/database/**
- supabase/migrations/**
- features/**

## Invariants

- `requireSession()` resolves identity from the server-side session only. It
  reads no request body, query parameter, or header, and accepts no argument
  that could carry a caller-supplied identity.
- `requireSession()` throws a typed `AuthenticationError`; it never returns
  null for a caller to forget to check.
- An unauthenticated dashboard request redirects to `/sign-in` and discloses
  nothing about whether the requested resource exists.
- Route protection is enforced server-side. A proxy check is defense in depth
  and does not replace the check in the dashboard layout.
- The existing CSP and security headers in `proxy.ts` continue to apply
  unchanged; verify the nonce still matches rendered script tags after editing
  the proxy.

## Acceptance criteria

- An authenticated request to `/dashboard` renders.
- An unauthenticated request redirects to `/sign-in`.
- A request supplying `userId` in its body or query is unaffected by it.
- An expired session is treated as unauthenticated, not as an error page.
- Typecheck, lint, format, and tests pass.

## Required tests

- integration: authenticated request reaches the dashboard
- security: unauthenticated dashboard request redirects and reveals nothing
- security: a client-supplied `userId` does not change the resolved identity
- security: an expired session is rejected

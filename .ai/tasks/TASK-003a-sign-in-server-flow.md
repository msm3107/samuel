# TASK-003a — Sign-in server flow

## Objective

Implement the server side of sign-in — requesting a magic link, starting
Google OAuth, completing the PKCE code exchange, and signing out — so the
sign-in screen (TASK-003) only calls these functions and renders their
results.

## Owner agent

Backend

## Dependencies

TASK-001 (client boundary), TASK-002 (session resolution).

## Allowed files

- lib/auth/sign-in/**
- app/(auth)/auth/callback/route.ts
- tests/unit/auth/**
- tests/security/auth/** (including extending the shared stub harness)
- tests/integration/auth/**

## Forbidden files

- lib/database/**
- proxy.ts
- app/(auth)/sign-in/** (TASK-003)
- components/**
- supabase/**
- features/**

## Decisions already made

- Magic links use PKCE, the `@supabase/ssr` default. A link completes only in
  the browser that requested it. Opening it elsewhere fails with a specific,
  user-safe code.
- Signing in with a new address creates the account (`shouldCreateUser: true`),
  so a request never reveals whether an address is registered.
- After sign-in the user always lands on `/dashboard`. There is no `next`,
  `redirectTo`, or return-URL parameter, so there is nothing to open-redirect.

## Invariants

- Every function is server-only and takes no identity. Inputs are validated
  with Zod before any call to Supabase:
  - email: trimmed, lowercased, RFC-valid, at most 254 characters
  - code and flow id: bounded, charset-restricted strings
- Every URL handed to Supabase (`emailRedirectTo`, `redirectTo`) is built from
  `NEXT_PUBLIC_APP_URL`, never from a request header.
- Results are deterministic codes, not messages, and not Supabase error text:
  `link_sent`, `invalid_email`, `unavailable` for the magic-link request, plus
  callback failure codes. The screen maps codes to copy.
- Requesting a magic link returns `link_sent` for any valid address, registered
  or not. A per-address resend throttle from Supabase also maps to `link_sent`,
  because a link was already sent. Only an outage or misconfiguration maps to
  `unavailable`.
- OAuth initiation returns the provider URL only after checking that its origin
  is the configured Supabase origin.
- The callback route:
  - accepts only `GET` with a validated `code`, plus an optional `sb_flow_id`
    passed to `exchangeCodeForSession`
  - on success, answers `303` to `/dashboard`
  - on any failure, answers `303` to `/sign-in?error=<code>`, with the code
    from a fixed allowlist, never echoing input
  - sends `Cache-Control: private, no-store` on every response
  - never logs the code, verifier, tokens, or email
- Sign-out is a server action (Next.js checks its origin), never a `GET`, and
  clears the session cookies even if the auth server call fails.
- No function logs an email address, token, code, or cookie value.

## Acceptance criteria

- A valid email produces `link_sent`, and the Supabase OTP request carries an
  `emailRedirectTo` of `<NEXT_PUBLIC_APP_URL>/auth/callback`.
- An invalid email produces `invalid_email` without calling Supabase.
- The callback with a valid code and verifier sets session cookies and
  redirects to `/dashboard`. A missing, malformed, expired, reused, or
  other-browser code redirects to `/sign-in` with the matching allowlisted
  error code and sets no session.
- A spoofed `Host` or `X-Forwarded-Host` header does not change any redirect
  URL.
- Typecheck, lint, format, and tests pass.

## Required tests

- unit: email normalization and rejection
- security: registered and unregistered addresses produce identical results
- security: redirect URLs ignore a spoofed Host header
- security: callback rejects a code without the matching verifier (login CSRF)
  and a replayed code
- security: callback error codes come from the allowlist, never from input
- integration: magic-link request, then callback, then `requireSession()`
  resolves the user, against the stub auth server

## Amendments

- 2026-09-15: this task also updated `.ai/` planning documents (its own
  contract, the TASK-003b draft, the amended TASK-003, and `.ai/PLAN.md`) and,
  after security review, two TASK-001 files. See "Cookie hardening" in
  `.ai/handoffs/TASK-003a-handoff.md`: session cookies were being written
  without `HttpOnly` or `Secure`, which put the access and refresh tokens
  within reach of injected script. Fixing that in `lib/database/` was judged a
  higher duty than the file boundary (`AGENTS.md` §1: preserve security first).

## Open items (not blockers)

- Google sign-in initiated without JavaScript would be a form POST redirected
  to another origin, which `form-action 'self'` blocks. With JavaScript, the
  navigation is not a form submission. Supporting no-JS Google sign-in would
  require widening `form-action`, which is a CSP decision for the project owner.
- auth-js can append `sb_flow_id` to redirects (the experimental
  `appendPkceFlowIdToRedirects`), which makes concurrent sign-ins in several
  tabs exchange the right verifier. Enabling it changes client options in
  `lib/database/`, a TASK-001 file.

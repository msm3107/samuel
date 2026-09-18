# TASK-003d — Sign-in hardening from the Codex review

## Objective

Fix the sign-in defects the independent Codex review of PR #6 found in code
already merged: a retried sign-in breaking the first link (F1), anonymous
sign-outs through the refresh limit (F2), no way to sign out (F3, F6), and
smaller gaps in the proxy matcher (F7), error pages (F9) and configuration
validation (F10).

## Owner agent

Backend, then Frontend for the sign-out control and error pages.

## Dependencies

TASK-003b (local Supabase, for the real-Supabase regression tests).

## Allowed files

- lib/database/session-client.ts, lib/database/proxy-session-client.ts
  (flow ids; keeping cookies when a session could not be verified)
- proxy.ts (cookie handling on unverifiable sessions; the matcher)
- lib/env/server-env.ts (https in production)
- supabase/config.toml (callback allowlist entries carrying `sb_flow_id`)
- app/(dashboard)/layout.tsx, components/forms/sign-out-form.tsx
- app/error.tsx, app/global-error.tsx
- tests/unit/\*\*, tests/security/\*\*, tests/integration/\*\*,
  tests/supabase/\*\*

## Forbidden files

- supabase/migrations/\*\* (rate limiting is TASK-003c)
- lib/auth/sign-in/response-floor.ts

## Invariants

- **F1:** every PKCE flow carries its own flow id through the redirect
  (`appendPkceFlowIdToRedirects`), so a later sign-in, or one GoTrue rejects,
  cannot remove the verifier a pending link needs. Opening the first of two
  requested links signs in.
- **F2:** a session the proxy could not verify is never deleted. When the
  lookup failed (unverifiable), refreshed tokens are still written, but no
  cookie is removed: a 429 or an outage says nothing about the session.
- **F3/F6:** a signed-in person can sign out from the dashboard. Signing out
  revokes the session on the auth server, so replaying the old cookies is
  rejected.
- **F7:** security headers are skipped only for `/widget/…` and `/widget.js`,
  not for every path starting with "widget".
- **F9:** an unexpected error renders a page with a reference (Next.js's error
  digest), never a stack trace.
- **F10:** in production, `SUPABASE_URL` and `NEXT_PUBLIC_APP_URL` must be
  https, except loopback hosts (production builds run locally in tests).

## Decisions for the project owner (not taken here)

- Session lifetime: an absolute limit and an idle limit (GoTrue
  `sessions.timebox` and `sessions.inactivity_timeout`), and the cookie's
  maximum age to match. Until then, sign-out is the way to end a session.

## Acceptance criteria

- A real-Supabase test requests two links for one address and signs in with
  the first. It fails before the fix.
- With a refresh answered 429, the proxy response carries no cookie deletion.
- A real-Supabase test signs in, signs out through the app, and has the old
  cookies rejected.
- The dashboard shows a sign-out control operable by keyboard.
- Typecheck, lint, format, unit, security, `test:supabase` and both e2e
  suites pass.

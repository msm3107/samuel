# TASK-003 — Sign-in screen

## Objective

Let a person sign in with a magic link or Google, accessibly.

## Owner agent

Frontend

## Dependencies

TASK-001, TASK-002, TASK-003a (sign-in server flow). The end-to-end acceptance
criteria also need TASK-003b (local Supabase and CI).

## Allowed files

- app/(auth)/sign-in/**
- components/forms/**
- tests/e2e/auth/**
- tests/unit/sign-in/**
- playwright.config.ts
- package.json, pnpm-lock.yaml (`@playwright/test` pinned, plus `test:e2e`
  scripts only)

## Forbidden files

- lib/auth/** (including `lib/auth/sign-in/`, owned by TASK-003a)
- app/(auth)/auth/** (the callback route, owned by TASK-003a)
- lib/database/**
- features/**
- proxy.ts
- supabase/**

## Invariants

- The screen defines no security boundary. It calls the TASK-003a functions in
  `lib/auth/sign-in/` and renders their result codes; it decides nothing.
- Callback error codes arriving as `?error=` are mapped to copy through a fixed
  table. Unknown values show the generic message, and the parameter is never
  rendered verbatim.
- Errors are generic. "Check your email if that address has an account" — never
  a message that distinguishes a registered address from an unregistered one.
- No password field. MVP supports magic link and Google only (`README.md` §9).
- WCAG 2.2 AA: labelled inputs, visible focus states, errors announced to
  screen readers, no status conveyed by color alone.
- Submitting twice does not send two magic links; the control disables while
  in flight.

## Acceptance criteria

- Magic link sign-in completes end to end against local Supabase.
- Google OAuth completes end to end, or is documented as untestable locally
  with the manual verification steps recorded in the handoff.
- The form is fully operable by keyboard.
- Typecheck, lint, format, and tests pass.

## Required tests

- e2e: magic link request shows the confirmation state
- e2e: the form is reachable and submittable by keyboard alone
- unit: an unknown address produces the same message as a known one

## Amendments

- 2026-09-15, approved by the project owner:
  - The server-side flow moved to TASK-003a.
  - Magic links use PKCE, so they complete only in the requesting browser, and
    the screen explains the other-browser failure.
  - Playwright is added here as the first user-facing flow (`AGENTS.md` §2).
  - Local Supabase and CI moved to TASK-003b.
- 2026-09-17, recorded after contract review:
  - E2E support code (stub auth server, launcher, build script, placeholder
    environment) lives in `tests/e2e/auth/support/`, inside this task's
    `tests/e2e/auth/**` scope, mirroring `tests/security/auth/support/`.
  - `playwright.config.ts` reads `process.env.CI` once, behind a single
    `eslint-disable-next-line` with its reason. `eslint.config.mjs` is not
    changed.
  - Acceptance criterion 1 ("end to end against local Supabase") is proven
    against the stub only. TASK-003b owns running the same Playwright suite
    against real Supabase.
  - Acceptance criterion 2 (Google OAuth) is untestable locally without Google
    credentials; manual verification steps are in the handoff.

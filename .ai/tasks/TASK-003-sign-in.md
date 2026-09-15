# TASK-003 — Sign-in screen

## Objective

Let a person sign in with a magic link or Google, accessibly.

## Owner agent

Frontend

## Dependencies

TASK-001, TASK-002.

## Allowed files

- app/(auth)/**
- components/forms/**
- tests/e2e/auth/**

## Forbidden files

- lib/auth/**
- lib/database/**
- features/**
- proxy.ts

## Invariants

- The screen defines no security boundary. It calls the auth helpers and
  renders their result; it decides nothing.
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

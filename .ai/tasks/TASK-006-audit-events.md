# TASK-006 — Audit events

## Objective

Record security-sensitive business actions, without recording anything that
would make the audit log itself a liability.

## Owner agent

Database, then Backend

## Dependencies

TASK-004, TASK-005.

## Allowed files

- supabase/migrations/**
- features/organizations/**
- tests/integration/audit/**
- tests/security/audit/**

## Forbidden files

- lib/auth/**
- app/**

## Invariants

- `audit_events` carries `organization_id`, `actor_user_id`, `event_type`,
  `entity_type`, `entity_id`, `created_at`, and `metadata jsonb`.
- The table is append-only. No update or delete path exists in application
  code, and RLS grants no update or delete to any user role.
- `event_type` is constrained to a known set, extended by migration rather than
  by free-form strings at call sites.
- `metadata` is validated by a Zod schema per event type before insertion.
  Arbitrary objects are not accepted (`README.md` §14, database JSON fields).
- Nothing in an audit row may contain a password, token, authentication header,
  raw payment data, or personal information beyond `actor_user_id`. A test
  asserts this against a representative payload.
- Recording an audit event never fails the business operation it describes —
  but a failure to record is logged at error level, never swallowed.

## Acceptance criteria

- The events listed in `README.md` §6 are representable.
- An attempt to update or delete an audit row fails at the database level.
- Cross-tenant reads of audit events fail.
- Typecheck, lint, format, and tests pass.

## Required tests

- integration: an event is recorded with the correct actor and organization
- security: update and delete are refused by RLS
- security: cross-tenant audit read fails
- security: a payload carrying a token-shaped field is rejected or redacted

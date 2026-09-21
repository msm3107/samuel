# TASK-009 — AI systems services and routes

## Objective

Let organization members list, read, create, edit, archive and un-archive
their AI systems through the application, on top of TASK-008's table and
row-level security.

## Owner agent

Backend

## Dependencies

TASK-005 (`requireOrganizationPermission`), TASK-007 (`lib/http/api.ts`),
TASK-008 (`ai_systems`, its RLS, its audit triggers and
`lib/validation/text.ts`).

## Allowed files

- features/ai-systems/**
- app/api/organizations/[organizationId]/ai-systems/**
- tests/integration/ai-systems/**
- tests/security/ai-systems/**
- tests/unit/ai-systems/**

## Forbidden files

- supabase/migrations/**
- lib/auth/**
- lib/security/**

## Routes

| Method | Path                                                                          | Permission          |
| ------ | ----------------------------------------------------------------------------- | ------------------- |
| GET    | `/api/organizations/[organizationId]/ai-systems?status=active\|archived\|all` | `organization.read` |
| POST   | `/api/organizations/[organizationId]/ai-systems`                              | `systems.manage`    |
| GET    | `/api/organizations/[organizationId]/ai-systems/[systemId]`                   | `organization.read` |
| PATCH  | `/api/organizations/[organizationId]/ai-systems/[systemId]`                   | `systems.manage`    |

## Decisions

Proposed by the implementer; all seven accepted on the PR #23 review. Accepted by Mikołaj Smoliniec (project owner), 2026-09-21.

- **Nested under the organization.** The organization is authorized first,
  and every query filters by it; there is no lookup by system ID alone.
  Rejected: `/api/ai-systems/[id]`, which must find a row before knowing
  whose it is.
- **Archive and un-archive are `PATCH { "status" }`.** One write path; the
  database already audits them as their own events. Rejected: separate
  `/archive` endpoints, a second path to secure for the same column.
- **404 `ai_system_not_found`** for a system the member's organization does
  not have, including another organization's system; **403** stays the
  answer for an organization the user does not belong to.
- **409 `ai_system_name_taken`** on create, rename or un-archive into an
  active name. Only the caller's own organization is checked, so this
  leaks nothing across tenants.
- **No audit calls in the application.** TASK-008's triggers write every
  event in the same transaction; a second writer could disagree.
- **Response fields:** `id`, `name`, `description`, `systemType`,
  `provider`, `status` (README §66). Timestamps are added when a screen
  needs them.
- **IDs are UUIDs**, as for organizations; README §67's prefixed public IDs
  are optional and would mix two styles.
- **Lists are capped at 200**, ordered by name. No pagination until an
  organization has that many systems; a cut-short list says `truncated: true`.

## Amendment: the PR #23 review

- **`truncated`** on the list response (finding 1), so a client can tell
  200 systems from more.
- **Names, providers and descriptions are normalized to NFC** in the
  schemas (finding 2), and organization names too, in
  `features/organizations/organization.ts` (out of contract, recorded
  here). A database CHECK (`is nfc normalized`) follows with the next
  migration that touches these tables, so direct Data API writes are
  covered too. Decided by Mikołaj Smoliniec (project owner), 2026-09-21.
- **Public IDs:** plain UUIDs stay. The widget will not expose
  `ai_systems.id` at all; it gets its own rotatable, revocable public key
  when that phase is designed (reviewer's recommendation, recorded for the
  widget phase).

## Invariants

- Route order: same-origin check (writes) → authenticate → authorize →
  validate → execute → serialize.
- Bodies are strict: a body carrying `organizationId`, `id`, `status` on
  create, or any unknown field is refused with 400.
- Every query is scoped by `organization_id` from the authorized access,
  never from the body.
- Validation mirrors the table's CHECKs, including control and format
  characters, so a valid request is never refused by the database as
  invalid.
- The session client only; the service role cannot write AI systems.

## Acceptance criteria

- A member creates, edits, archives and un-archives a system; a viewer reads
  but cannot write.
- Cross-tenant read, write and enumeration fail through the routes.
- A duplicate active name is a deterministic 409, concurrent requests
  included.
- Typecheck, lint, format, and tests pass.

## Required tests

- integration: create, read, list with each status filter, edit, archive,
  un-archive, duplicate name, concurrent duplicate
- security: user A cannot read, list, create in, edit, or archive
  organization B's systems through the routes; a system ID from B used
  under A's organization is a 404
- security: a viewer cannot create or edit; a smuggled `organizationId`,
  `id` or `status`-on-create is refused
- security: cross-origin writes refused; error bodies carry only a code and
  a reference
- unit: the schemas mirror the table's rules

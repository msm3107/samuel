# TASK-017 — Disclosure versioning service and routes

## Objective

Let organization members read an AI system's disclosure history and
publish a new version through the application, on TASK-016's table. The
screen is TASK-018; the public configuration endpoint is Phase 6. The
migration also carries two rules owed on older tables: AI systems refuse
deletes (PR #31 review, note 1) and the NFC check (PR #23 review).

## Owner agent

Backend

## Dependencies

TASK-005 (`requireOrganizationPermission`; `disclosures.manage` is member
and up), TASK-007 (`lib/http/api.ts`), TASK-009 (the AI system routes and
the NFC decision), TASK-016 (`disclosures`, its RLS and triggers).

## Allowed files

- supabase/migrations/**: one new migration only
- supabase/tests/**
- features/disclosures/**
- app/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures/**
- lib/validation/text.ts: the separator check (PR #31 review, note 2)
- tests/unit/disclosures/**, tests/unit/validation/**
- tests/integration/disclosures/**, tests/security/disclosures/**
- tests/integration/database/**, tests/security/tenant-isolation/**

## Forbidden files

- Existing migrations
- app/** outside the route above; components/**

## Routes

| Method | Path                                                                    | Permission           |
| ------ | ----------------------------------------------------------------------- | -------------------- |
| GET    | `/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures` | `organization.read`  |
| POST   | `/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures` | `disclosures.manage` |

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-22:

- **The routes are under the AI system.** A version has no identity apart
  from its system (TASK-016: one history per system), so the system is
  in the path. Rejected: under the organization with `aiSystemId` in the
  body, as for deployments, where every publish names the system twice
  over and a version is never addressed on its own.
- **A stale publish is refused**, 409 `disclosure_changed`. A publish names
  `expectedVersion`, the version it was based on (null for the first).
  The check and the insert run in `public.publish_disclosure`, under
  TASK-016's per-system lock, so two people can't both pass it. Rejected:
  latest wins, which silently replaces a colleague's newer text on the
  live widget.
- **The NFC constraints are validated in the migration.** The application
  has normalized every write since #23. If a production row isn't NFC,
  the migration fails before changing anything. Rejected: rewriting rows
  in the migration, which would change names without an audit event; and
  `not valid`, which would block every later edit of such a row.
- **A publish identical to the current version is refused**, 409
  `disclosure_unchanged`: same message, language and on or off. Every
  version is permanent evidence. Checked in the table's own trigger, so
  it holds for every writer.

From the PR #31 review (owner, 2026-09-22):

- **AI systems refuse deletes**, the service role included, unless their
  organization is being deleted, as deployments do (#25). Only deleting
  the whole organization then removes disclosure history.
- **`23503` and `42501` from a publish are both answered as not found or
  not permitted without telling organizations apart:** `23503` (a system
  the caller can't see) is 404 `ai_system_not_found`; `42501` (a role
  lost mid-request) is 403, as elsewhere.
- **The archived system is `23514` with the hint `ai_system_archived`**,
  matched by code and hint, never message text.
- **`lib/validation/text.ts` mirrors the one-line rule**, U+2028 and
  U+2029 included.

Proposed by the implementer, awaiting the owner:

1. **The stale check is a database function; plain inserts stay
   allowed.** `publish_disclosure` runs as the caller, so RLS and every
   TASK-016 trigger apply as to a direct insert. A Data API caller who
   inserts directly skips only the stale check, which protects a person
   from an accident, not the history: every version is kept either way.
   Rejected: revoking the insert grant and making the function security
   definer, which would move the tenant boundary from RLS into the
   function.
2. **The fixed hints are `disclosure_changed` and `disclosure_unchanged`,
   with code `PT409`**, which PostgREST answers as HTTP 409, as
   `create_organization` uses `PT429`.
3. **A unique violation (`23505`) is `disclosure_changed`.** Only a
   concurrent direct insert that skipped the stale check reaches it:
   another version won.
4. **The GET is one query:** the AI system with its versions embedded
   through the composite foreign key, newest first, capped at 200 with
   `truncated`. An unknown system (another organization's included) is
   404; a system with no versions is an empty list. The response carries
   `aiSystemStatus`, so the screen can say why publishing is closed.
5. **`enabled` is required** in the body, so turning the notice off is
   always said, never defaulted.
6. **The message is counted in code points**, as the table's
   `char_length` counts, not UTF-16 units: an emoji is one character in
   both places. Zod 4's `max` already counts that way; unit tests with 500
   and 501 emoji pin it, should a Zod upgrade change it.
7. **Response fields:** `id`, `version`, `message`, `language`, `enabled`,
   `createdAt`, `createdBy` (the publisher's user ID; TASK-018 can show
   who published).
8. **No audit calls in the application.** TASK-016's trigger writes
   `disclosure.published`, without the message.

## Invariants

- Route order: same-origin check (POST) → authenticate → authorize →
  validate → execute → serialize.
- The body is strict: an organization, system, ID, version, author or any
  unknown field is 400.
- Every query is scoped by `organization_id` from the authorized access,
  never from the body.
- The session client only.
- No one deletes an AI system except by deleting its organization.
- The message is plain text end to end; nothing here renders it.

## Acceptance criteria

- A member publishes and reads the history; a viewer reads but can't
  publish.
- A stale publish and an unchanged publish are deterministic 409s,
  concurrent publishes included.
- Cross-tenant read, publish and enumeration fail through the routes.
- Deleting an AI system is refused, for a user and for the service role;
  deleting its organization still removes it.
- A non-NFC name can't be stored in `organizations` or `ai_systems`.
- Typecheck, lint, format, and tests pass.

## Required tests

- integration: publish, history order, stale, unchanged, off as a new
  version, the archived system, concurrent publishes with one expected
  version (one wins, the rest are 409), the audit row
- security: user A can't read or publish B's disclosures through the
  routes; B's system ID under A is 404; a viewer can't publish; smuggled
  fields are refused; cross-origin writes are refused; error bodies carry
  only a code and a reference
- database: `publish_disclosure` (grants, visibility first, stale,
  unchanged); the AI system delete and truncate refusals; the NFC checks
- unit: the schema (trim, NFC, code points, separators, languages), the
  serializer, the separator check

# TASK-013 — Deployment services and routes

## Objective

Let organization members list, read, register, archive and restore
deployments through the application. This builds on TASK-011's table and
row-level security, and on TASK-012's hostname check.

## Owner agent

Backend

## Dependencies

TASK-005 (`requireOrganizationPermission`; `deployments.manage` is member
and up), TASK-007 (`lib/http/api.ts`), TASK-011 (`deployments`, its RLS
and triggers), TASK-012 (`validateVerificationTarget`).

## Allowed files

- features/deployments/**
- app/api/organizations/[organizationId]/deployments/**
- tests/integration/deployments/**
- tests/security/deployments/**
- tests/unit/deployments/**

## Forbidden files

- supabase/migrations/**
- lib/** (TASK-012's module is used, not changed)

## Routes

| Method | Path                                                                                       | Permission           |
| ------ | ------------------------------------------------------------------------------------------ | -------------------- |
| GET    | `/api/organizations/[organizationId]/deployments?status=active\|archived\|all&aiSystemId=` | `organization.read`  |
| POST   | `/api/organizations/[organizationId]/deployments`                                          | `deployments.manage` |
| GET    | `/api/organizations/[organizationId]/deployments/[deploymentId]`                           | `organization.read`  |
| PATCH  | `/api/organizations/[organizationId]/deployments/[deploymentId]`                           | `deployments.manage` |

## Decisions

Decided by Mikołaj Smoliniec (project owner), 2026-09-22:

- **Under the organization, not the AI system.** `aiSystemId` goes in the
  body on create (README §14's `createDeploymentSchema`), and is an optional
  filter on the list.
  - Why: a deployment has its own ID, TASK-015's screen addresses it alone,
    and listing an organization's deployments is one query.
  - Rejected: nesting under the system, where every call must match two IDs.
- **One API code for each reason TASK-012 refuses a hostname:**
  `hostname_invalid`, `hostname_scheme_not_allowed`,
  `hostname_credentials_not_allowed`, `hostname_private_network`,
  `hostname_ip_address_not_allowed`, `hostname_port_not_allowed` and
  `hostname_path_not_allowed`, each with 400. The form can say what to fix,
  and no code reveals anything the person didn't type. Rejected: one
  `invalid_hostname`.
- **Each deployment carries `aiSystemStatus`,** read in the same query
  through the composite foreign key. A deployment of an archived system is
  never verified, whatever its own status (PR #25 review, finding 2).
  Creating or restoring one under an archived system is 409
  `ai_system_archived`.
- **Both forms of the hostname.** `hostname` is the stored ASCII form;
  `unicodeHostname` is converted on the server, since browsers have no
  punycode decoder. TASK-015 shows the ASCII form beside the Unicode one
  whenever they differ, so a lookalike (`аpple.com` with a Cyrillic "а") can't
  pass as another name (PR #26 review, note 3). Rejected: ASCII only, which
  makes a real `bücher.de` unreadable.

Proposed by the implementer; all eight accepted on the PR #27 review.
Accepted by Mikołaj Smoliniec (project owner), 2026-09-22.

- **TASK-012's output is the only hostname stored.** The route validates
  the body with Zod (strict; the hostname only bounded at 1,024
  characters), then calls `validateVerificationTarget`, and passes on its
  hostname, never the input.
- **`aiSystemId` naming no system in this organization is 404
  `ai_system_not_found`**, as the composite foreign key reports it.
  Another organization's system gets the same answer, so it reveals
  nothing. Rejected: 400, which would treat a missing resource as a
  malformed request.
- **409 `deployment_exists`** when the system already has an active
  deployment at that hostname, on create or restore. Only the caller's own
  system is checked (TASK-011's unique index), so it leaks nothing across
  systems or tenants.
- **PATCH changes `status` only**, and names no version. Archiving twice is
  harmless, and a restore that would clash is refused by the database.
  Rejected: TASK-010's `expectedUpdatedAt`, which protects edits of
  several fields, not a single switch.
- **Response fields:** `id`, `aiSystemId`, `aiSystemStatus`, `hostname`,
  `unicodeHostname`, `status`, `createdAt` and `updatedAt`. TASK-015 shows
  when a deployment was registered.
- **Lists as for AI systems:** ordered by hostname, capped at 200, and
  `truncated: true` when cut short. A filter naming another organization's
  system (or no system) lists nothing; no lookup tells the two apart.
- **No audit calls in the application.** TASK-011's triggers write
  `deployment.created`, `deployment.archived` and `deployment.unarchived` in
  the same transaction, without the hostname.
- **The hostname is never logged.** A refusal logs its code only, as every
  API error does.

## Amendment: the PR #27 review

Decided by Mikołaj Smoliniec (project owner), 2026-09-22; recorded for later
tasks, with no change to this one's code:

- **For TASK-015's contract** (note 1): `unicodeHostname` can hold
  right-to-left letters (`xn--4dbc.com` is Hebrew, then `.com`), and a label
  may mix directions. Show it left-to-right and isolated, as
  `<bdi dir="ltr">`, beside the ASCII form, never with `dir="auto"`, so the
  parts of the name always read in DNS order.
- **For the next migration that touches `deployments`** (note 2): the
  archived-system trigger also sets a fixed hint, `ai_system_archived`, and
  the service matches the error code plus that hint instead of the message
  text, so a reworded message can't turn the 409 into a 500. Not worth a
  migration on its own.

## Amendment: TASK-014

- **Responses gain `publicId`**, the deployment's public identifier.
- **The archived-system refusal is matched by its fixed hint**,
  `ai_system_archived`, instead of its message text (PR #27 review, note
  2).

## Invariants

- Route order: same-origin check (writes) → authenticate → authorize →
  validate → execute → serialize.
- Bodies are strict: `organizationId`, `id`, `status` on create, or any
  unknown field is 400.
- Every query is scoped by `organization_id` from the authorized access,
  never from the body.
- Only `validateVerificationTarget`'s output reaches the database.
- The session client only; the service role cannot write deployments
  (TASK-011: an event needs an actor).

## Acceptance criteria

- A member registers, archives and restores a deployment; a viewer reads
  but cannot write.
- Every target in Phase 4's exit criteria is refused through the route with
  its code, and nothing is stored.
- Cross-tenant read, write and enumeration fail through the routes.
- A duplicate active hostname on one system is a deterministic 409,
  concurrent requests included.
- Typecheck, lint, format, and tests pass.

## Required tests

- integration: create, read, list with each filter, archive, restore,
  duplicate, concurrent duplicate, the archived-system rules, audit events
- security: user A cannot read, list, create in, or archive organization
  B's deployments through the routes; B's deployment ID or AI system ID
  used under A is a 404
- security: a viewer cannot write; smuggled fields are refused; cross-origin
  writes are refused; error bodies carry only a code and a reference
- security: each unsafe target is refused before any insert
- unit: the schemas, the code map, the serializer

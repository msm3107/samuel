# TASK-014 — Public deployment identifier

## Objective

Give every deployment a public identifier: the value a customer puts in the
widget's `data-deployment` attribute (README §11, §67). It comes from a
CSPRNG, carries enough entropy to resist enumeration, and is never
treated as authorization (PLAN, Phase 4).

## Owner agent

Database

## Dependencies

TASK-011 (`deployments`), TASK-013 (the deployment API, whose response
gains `publicId`).

## Allowed files

- supabase/migrations/**: one new migration only
- supabase/tests/**
- lib/security/public-id.ts (new)
- features/deployments/**: the response field and the archived-system hint
- tests/unit/security/public-id.test.ts (new)
- tests/integration/database/**
- tests/unit/deployments/**, tests/security/deployments/**,
  tests/integration/deployments/**: fixtures for the new field

## Forbidden files

- Existing migrations
- app/**

## Decisions

Decided by Mikołaj Smoliniec (project owner), 2026-09-22:

- **The database generates it.** No insert can skip it or choose it, the
  service role's included, and the migration fills existing rows the same
  way.
  - `lib/security/public-id.ts` recognizes the format, for Phase 6's
    endpoint to check before any lookup.
  - Amends the plan's primitives table, which put generation in
    `lib/security`.
  - Rejected: generating in TypeScript, which still needs SQL to fill
    existing rows (two generators of one format) and relies on every insert
    path remembering it.
- **`dep_` and 26 characters of lowercase base32** (a–z, 2–7): 130 random
  bits. Safe in HTML attributes and URLs, and case-insensitive. Rejected:
  README §11's `dep_public_` and 12 mixed-case characters (about 71 bits).
- **Archive = revoke; registering again = a new ID.**
  - The ID is fixed for a deployment's life.
  - An archived deployment, or one whose AI system is archived, resolves to
    nothing.
  - The ID is public by design, and a copied tag earns no evidence, because
    the verifier checks the hostname. So this covers the "revocable widget
    key" owed since TASK-009.
  - Rejected: a rotate action, which breaks the live widget and answers no
    threat the archive path doesn't.
- **The lookup from public ID to deployment is TASK-019's**, designed with
  the public endpoint that uses it. It must require both the deployment and
  its AI system to be active (PR #25 review, finding 2).

Also decided, on the PR #27 review (note 2): this migration touches
`deployments`, so the archived-system refusal gains a fixed hint,
`ai_system_archived`, and the service matches the code plus that hint.

Proposed by the implementer, awaiting the owner:

- **One generator, `private.generate_public_id(prefix)`**, for every
  prefixed public ID (Phase 9's reports will call it).
  - Each character is one random byte from `gen_random_bytes` masked to 5
    bits. 256 is a multiple of 32, so there's no bias.
  - The generator isn't exposed through the API.
- **Set by a BEFORE INSERT trigger, not a column default.**
  - A default runs with the inserting user's privileges, and users can't
    execute the generator.
  - The trigger is security definer and sets one column. It overwrites any
    value named on insert, so even the table owner can't choose an ID.
- **Existing rows are filled by a one-off volatile default**, dropped
  straight after. It fires no triggers, so no `updated_at` moves and no
  audit event is written (checked on local data before the change).
- **The guard keeps the public ID** as it keeps the hostname: no writer
  changes it short of the table owner disabling the trigger.
- **The API sends `publicId`** with every deployment. Only members of the
  organization read it (RLS); the anonymous role has no grant on the
  table.
- **The format check is exact**: no trimming or case folding, so each ID
  has one spelling.

## Invariants

- Every deployment has a unique, well-formed public ID that no writer
  chose.
- A public ID never changes; archiving revokes it.
- A public ID is never authorization.
- The format in `lib/security/public-id.ts` and the table's CHECK agree
  (tested against the real database).

## Acceptance criteria

- `supabase db reset` applies the migration cleanly, and existing rows get
  IDs without an `updated_at` change or an audit event.
- IDs are distinct, well-formed, and use all 32 characters evenly.
- No user or writer can choose or change an ID.
- Typecheck, lint, format, and tests pass.

## Required tests

- database (pgTAP): the generator's shape, prefixes and distribution;
  privileges; the column; the trigger overriding a named ID; the guard;
  re-registration; the hint
- integration (real database): IDs pass the application's format check; a
  user can't choose or change one; the anonymous role can't read them
- unit: the format check

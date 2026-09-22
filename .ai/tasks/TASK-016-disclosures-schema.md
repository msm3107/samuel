# TASK-016 — Disclosures schema, RLS and immutability

## Objective

Create `disclosures`, the published versions of the notice an AI system's
widget shows (README §5, PLAN Phase 5), with row-level security that
confines each version to its organization and a database rule that no
published version ever changes. The versioning service is TASK-017 and the
configuration screen TASK-018; the public configuration endpoint is
Phase 6.

## Owner agent

Database

## Dependencies

TASK-008 (`ai_systems` and its `(organization_id, id)` key), TASK-005 (the
`disclosures.manage` permission: member and up), TASK-006
(`disclosure.published` is already an audit event type).

## Allowed files

- supabase/migrations/**: one new migration only
- supabase/tests/**
- tests/security/tenant-isolation/**
- tests/integration/database/**
- features/disclosures/languages.ts (new): the language list
- tests/unit/disclosures/** (new)

## Forbidden files

- Existing migrations, tables, policies and grants
- lib/** and app/**
- features/**, except the file above

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-22:

- **The 24 official EU languages** (PLAN open question 4). Article 50 is
  EU law, and a notice has to be in a language its reader understands.
  Adding a language later takes one migration, but removing one that
  customers publish in would not be that simple. The cost is the widget's
  few labels, translated 24 times in Phase 6. Rejected: a starter set of
  six, which leaves customers in other member states unable to comply;
  English only.
- **Saving publishes.** Every row is a published version, and no one
  updates a row, the service role included. Rejected: drafts that freeze
  on publishing. That is a state machine, and one mistake in it unfreezes
  history.
- **One current language per AI system.** A system has one version
  history, and its current version is the highest. A site in two languages
  needs two AI systems until a later task. Rejected for now: a history per
  language, which Phase 6 and the verifier would each have to choose
  between.
- **Turning a disclosure off is a new version** with `enabled = false`.
  When the notice was on or off is then part of the same immutable
  history. Rejected: an editable switch on a parent row, whose history
  would live only in the audit log.

Proposed by the implementer, awaiting the owner:

1. **The database numbers the versions**: 1 for a system's first, then one
   more than its highest. No writer chooses a number, so none can skip,
   repeat or rewind one. Concurrent publishes for one system take turns on
   a transaction lock, and `unique (ai_system_id, version)` is the backstop.
   Rejected: numbering in the TASK-017 service, where two requests could
   read the same highest version.
2. **A message is one line of plain text, 1 to 500 characters.**
   - No control characters (line breaks included).
   - No Unicode format characters except U+200D, the pattern already on
     organization and AI system names.
   - No leading or trailing space, and NFC-normalized.
   - A notice is a sentence or two, and the widget shows it as one
     paragraph. Refusing format characters stops a right-to-left override
     from making the notice read as something else. NFC means the text the
     verifier looks for on a page is one byte sequence.
   - Rejected: allowing line breaks, which the widget would have to render
     somehow.
3. **Nothing is published under an archived AI system**, as for
   deployments, not even a version that turns the notice off. The check
   runs after RLS and locks the system row, so it can't pass while an
   archive commits.
4. **No one deletes a version**, the service role included, except by
   deleting its organization or AI system. Verification checks (Phase 7)
   will cite versions. A statement trigger refuses `truncate`.
5. **The author and time are the database's.** `created_by` comes from the
   signed-in user's JWT, and a write with no user, the service role's
   included, is refused. `created_at` is `now()`. Like the audit log's
   actor, `created_by` has no foreign key, so the history outlives the
   user.
6. **Each version is audited** as `disclosure.published`, by trigger, with
   no metadata: the customer's text stays out of the audit log.
7. **`(organization_id, id)` is unique**, the target of verification
   checks' composite foreign key (Phase 7).
8. **The language list is mirrored** in `features/disclosures/languages.ts`,
   and a unit test keeps it equal to the constraint.
9. **A system the caller can't see is refused as if it didn't exist**
   (`23503`), before the version is counted. Found by the test subagent:
   the count runs through RLS, so a caller naming their own organization
   and another's system counted none of its versions and tried version 1.
   That gave a unique violation if the system had a disclosure and a
   foreign-key error if not, telling a stranger whether it had one. The
   same answer now covers another organization's system, a soft-deleted
   organization's, an archived one elsewhere, and one that doesn't exist.
   No one takes the version lock on a system they can't see. Rejected:
   counting as security definer, which fixes the count but still locks
   and reads before RLS; and documenting the leak.

## Invariants

- `organization_id uuid not null` with a foreign key. RLS is enabled in the
  same migration that creates the table.
- `(organization_id, ai_system_id)` references the same pair on
  `ai_systems`, so a version can't point at another organization's system.
- Access resolves through `authz.has_org_role`: viewers read, members and up
  publish, and no one reaches a soft-deleted organization's disclosures.
- A user sets only `organization_id`, `ai_system_id`, `message`, `language`
  and `enabled`, on insert. There is no update or delete grant.
- No writer updates a row, short of the table owner disabling the trigger
  (PLAN Phase 5, invariant 1).
- `message` is stored as plain text. Nothing in this task renders it.

## Acceptance criteria

- `supabase db reset` applies the migration cleanly.
- An update of a published version fails at the database level, for a
  user and for the service role, proven by an integration test against the
  real database (the PLAN's Phase 5 exit criterion).
- Cross-tenant read, publish and enumeration fail through RLS, proven
  against the real database.
- A viewer can't publish. No one deletes a version except by deleting its
  organization or AI system.
- Concurrent publishes for one system get distinct, consecutive versions.
- Typecheck, lint, format, and tests pass.

## Required tests

- security: user A can't read, publish into or enumerate organization B's
  disclosures, or publish under B's system
- security: a viewer can't publish; no user can update or delete
- security: `id`, `version`, `created_by` and `created_at` can't be chosen
  by a user
- security: a soft-deleted organization's disclosures are neither readable
  nor writable
- integration: the update refusal for a user and the service role
- integration: versions 1, 2, 3 in order, including concurrent publishes
- integration: the message, language and archived-system rules; the audit
  row, with empty metadata
- pgTAP: the table, constraints, grants, policies and triggers

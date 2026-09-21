# TASK-004a — Follow-ups from the review of PR #17

## Objective

Fix what the independent review of TASK-004 (PR #17) found in the merged
last-owner trigger and its tests, and record the owner's acceptances.

## Owner agent

Database

## Dependencies

TASK-004 (merged in #17).

## Allowed files

- supabase/migrations/** (a new migration; the merged one is never edited,
  since it may already be applied to a hosted database)
- tests/integration/database/**, tests/security/tenant-isolation/**
- .ai/handoffs/TASK-004-handoff.md (the owner's acceptances)
- .ai/tasks/TASK-007-organization-creation.md (open questions from the review)

## Forbidden files

- lib/**, features/**, app/**

## Invariants

- The owner check locks the organization row with `for no key update`, so it
  still serializes owner changes but no longer blocks membership inserts.
- The owner check refuses to decide under repeatable read, where its snapshot
  predates the lock. Read committed and serializable stay allowed.
- Existing behaviour and tests are unchanged apart from these.

## Acceptance criteria

- `supabase db reset` applies all migrations from empty.
- The concurrency test repeats the race enough times that a missing lock
  fails it in practice, not by luck.
- A member leaving an organization is tested.
- Typecheck, lint, format, and tests pass.

## Required tests

- integration: concurrent mutual demotion leaves one owner, in each of 20 races
- security: a member can delete their own membership

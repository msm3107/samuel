# Database Agent

## Scope

Schema, migrations, indexes, constraints, RLS policies, database tests, query
efficiency.

During a coordinated task, only this agent creates or modifies files under
`supabase/migrations/`, unless the orchestrator delegates it explicitly. This
prevents conflicting schema changes.

## Rules

- Every organization-owned table carries `organization_id uuid not null`.
- Enable Row Level Security on every user-accessible tenant table, and write
  the policies in the same migration that creates the table.
- Every migration is committed, deterministic, reviewable, and includes the
  foreign keys, constraints, and indexes the schema needs.
- Express invariants that belong in the database as `NOT NULL`, `UNIQUE`,
  `FOREIGN KEY`, and `CHECK` constraints rather than relying on application
  behavior.
- `verification_checks` is append-only. Never write an `UPDATE` path that
  rewrites recorded evidence.
- Published disclosure versions are immutable; an edit inserts a new version.
- Index the queries that actually run, and bound result sets.
- No destructive change without a written migration strategy. No destructive
  command against a production database, ever.
- Keep the schema compatible with future evidence-integrity fields
  (`payload_hash`, `previous_record_hash`).

## Required tests

Cross-tenant read, cross-tenant write, cross-tenant enumeration, and role
restrictions, exercised through RLS rather than through application code alone.

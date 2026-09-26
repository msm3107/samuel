# TASK-022 — The verification_checks schema

## Objective

Append-only evidence that a deployment was checked: the table, its
constraints, its row-level security and the triggers that make "never
mutate historical evidence" a property of the database rather than a rule
the application remembers. The integrity columns §20 reserves are created
here, nullable and unpopulated.

Nothing writes to it yet. TASK-023 fetches, TASK-024 inspects, TASK-025
schedules.

This opens Phase 7.

## Owner agent

Database

## Dependencies

TASK-011 (`deployments`, and its `unique (organization_id, id)`, created
for this table's foreign key), TASK-016 (`disclosures`, and its matching
unique key), TASK-006 (`audit_events`, for the append-only idiom this
follows). All merged.

## Allowed files

- supabase/migrations/\*\* (one new migration)
- supabase/tests/\*\* (its pgTAP file)
- features/verification/\*\* (new: the codes and the row's shape)
- README.md (§5's column list, §19's code list)
- .ai/PLAN.md (Phase 7 in progress)
- tests/\*\*

## Forbidden files

- app/\*\*, lib/\*\* — nothing reads this table yet, and a migration adding
  something the application reads ships before the code that reads it
- every existing migration — this one is additive; the unique keys it needs
  are already there
- public/widget.js, proxy.ts, next.config.ts

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-26:

- **`status` with a nullable `failure_code`.** `status` is `success` or
  `failure`; `failure_code` carries the reason from README §19 and is null
  exactly when the status is success, enforced by a check constraint so the
  two cannot disagree. `SUCCESS` is therefore **not** stored as a code:
  `status` already says it, and a second encoding of the same fact is a
  second thing that can be wrong. Cost: §19's example list includes
  `SUCCESS`, so the stored code table is that list minus one entry, and §19
  is amended to say why. Rejected: a code on every row including `SUCCESS`
  (every query and every report would compare a string against a magic
  value, and nothing would stop a row reading `failure` / `SUCCESS` unless
  `status` were dropped, which §5's column list has) and a status with the
  reason in `metadata` (the failure reason would stop being a constrained,
  queryable column, which is the thing §19 exists to prevent).
- **Idempotency is enforced by the database.** A `check_window` column
  holds the start of the window a check belongs to, with
  `unique (deployment_id, check_window)`. A cron that fires twice, or that
  overlaps itself, cannot write two rows for one window: the second gets a
  unique violation and TASK-025 reads that as "already done". Cost: a column
  §5's list does not name, and the window becomes a fact of the schema
  rather than only a setting of the job. Rejected: enforcing it in the route
  (two overlapping runs both read "none", both write, and an append-only
  table gains duplicate evidence that nothing can later remove).
- **A deployment with nothing to show is not checked**, so `disclosure_id`
  is `not null`. There is no notice to look for, so "was the disclosure
  present" has no answer; every evidence row names the exact version it was
  checked against; and the dashboard already tells the customer nothing is
  being shown (TASK-021). Cost: no record that we looked, for a deployment
  that is installed and publishing nothing. Rejected: recording with a null
  disclosure (the column would be nullable forever, every reader would carry
  the null, and §19 has no code for "you published nothing", so one would
  have to be invented in a schema task) and recording against a version that
  is turned off (the row would claim a version was expected when the product
  was deliberately showing nothing — evidence that misstates what happened).
- **`metadata` holds facts about the check, never page content.** Redirect
  chain length, response size, timings, which matcher failed. Nothing copied
  from the customer's page. Cost: an evidence report can say a check failed
  and why in §19's terms, but cannot show the page as it was served.
  Rejected: a short excerpt of the fetched page (the most convincing
  evidence, and the reason to refuse it is that a customer's page can
  contain anything, including personal data of their own visitors, which
  would then be in our database and in every backup — against §34) and
  dropping the column (§5 names it, and adding a `jsonb` column later to a
  table customers already rely on is the migration Phase 7's own note is
  written to avoid).

## Proposed by the implementer

Awaiting the owner's sign-off.

1. **Nothing writes this table but the service role.** No insert grant to
   `authenticated`, and no insert policy. Evidence is produced by the
   scheduled job, not by a user, so the one client that may write it is the
   one already confined to a single module (`lib/database/service-client`).
   Rejected: an insert policy for members, which would let a customer
   manufacture their own evidence.
2. **Append-only is four triggers, not a convention.** Update, delete and
   truncate are refused, exactly as `disclosures` and `audit_events` refuse
   them — the service role included, since it is the only writer and so the
   only thing that could rewrite history. Delete is refused unless the
   parent organization, AI system or deployment is itself going, which is
   how a cascade is told from a deletion.
3. **The tenant binding is in the foreign keys, not only in a column.**
   `(organization_id, deployment_id)` and `(organization_id, disclosure_id)`
   are composite foreign keys against the unique keys TASK-011 and TASK-016
   created for this table. A row naming one organization's deployment and
   another's disclosure is refused by the database, not by a code path.
4. **`checked_at` is the database's `now()`**, set by a trigger and not
   accepted from the writer, as `disclosures.created_at` is. A job's clock
   is not evidence. `check_window` **is** the writer's, because it is the
   schedule's fact rather than an observation.
5. **`status` and `failure_code` are text with check constraints**, not
   Postgres enums, as `deployments.status` and `ai_systems.status` are.
   Adding a code is then one migration rather than a type alteration, and
   the list reads in the table definition.
6. **`http_status`, `widget_detected` and `disclosure_version` are
   nullable**, and each is null for one stated reason: no response arrived,
   no body was inspected, no identifier was found. A check that failed at
   DNS has none of the three, and a row that pretended otherwise would be
   false evidence.
7. **`disclosure_version` is stored beside `disclosure_id`**, though the
   id determines it. It is what was _observed on the page_, which is the
   whole point of `DISCLOSURE_VERSION_MISMATCH`: the expected version is the
   one the id names, and the observed one is this column.
8. **`payload_hash` and `previous_record_hash` are created here, nullable,
   unpopulated, and constrained in shape.** 64 lowercase hex characters if
   present. §20 does not require the chain for launch; adding the columns
   later would be a migration across evidence rows customers already rely
   on, which is exactly what Phase 7's note asks to avoid.
9. **`metadata` is `jsonb not null default '{}'`, constrained to an
   object**, with the privacy rule in a table comment where a future writer
   will read it rather than only in this contract.
10. **Every member of a live organization reads it, viewers included.**
    Evidence is the thing customers rely on, and a viewer already reads the
    whole disclosure history. No one writes it.
11. **The indexes are the two reads Phase 8 will do**: a deployment's
    history newest first, and an organization's. Named here rather than
    left for the screen that needs them, because adding an index to a large
    evidence table later is the migration this phase is trying not to have.
12. **`features/verification/verification-check.ts` holds the codes and the
    row's shape**, with a real-database test asserting the list matches the
    check constraint — the same way `features/disclosures/languages.ts` is
    kept in step with its constraint. Nothing imports it yet; TASK-024 will.

## Invariants

- **No row is ever updated.** Not by a member, not by the service role.
- **No row is deleted** except with the organization, AI system or
  deployment it belongs to.
- **A check names one organization's own deployment and that organization's
  own disclosure**, enforced by composite foreign keys.
- **`failure_code` is null if and only if `status` is `success`.**
- **Two checks cannot exist for one deployment in one window.**
- **No customer page content is stored**, in `metadata` or anywhere else.
- **Nothing in this table is readable across organizations**, under RLS.

## Acceptance criteria

- A member reads their organization's checks; a member of another
  organization reads none of them.
- No role but the table owner can update, delete or truncate a row.
- A row naming another organization's deployment or disclosure is refused.
- A second row for the same deployment and window is refused.
- `status = 'success'` with a `failure_code`, and `status = 'failure'`
  without one, are both refused.
- Deleting the organization, the AI system or the deployment takes the
  checks with it and raises nothing.
- `payload_hash` and `previous_record_hash` accept a 64-character hex digest
  and refuse anything else.

## Required tests

- pgTAP: every constraint above, the grants, and the refusal triggers,
  including that a cascade deletes without raising while a direct delete
  raises.
- Real database, as the `authenticated` role: a member reads their own
  organization's checks and none of another's; no update or delete grant
  exists.
- Unit: the code list in `features/verification/` is exactly the constraint's
  list, asserted against the database rather than against a copy.

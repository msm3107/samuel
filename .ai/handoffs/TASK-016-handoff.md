## Handoff

### Summary

`disclosures` exists, which starts Phase 5: the published versions of the
notice an AI system's widget shows, confined to their organization by RLS.

- Saving publishes. Each save is a new row, and no one, the service role
  included, can update or delete one. That is the PLAN's Phase 5 exit
  criterion, proven against the real database.
- The database numbers each system's versions 1, 2, 3…, and sets the
  author and time.
- A disclosure is written in one of the 24 official EU languages, and
  turning it off is a new version with `enabled = false`.

There was no TASK-016 contract, so this task adds one. Four decisions are
the owner's (Mikołaj Smoliniec, 2026-09-22). The implementer proposed nine
more, all accepted on the PR #31 review. Accepted by Mikołaj Smoliniec
(project owner), 2026-09-22.

On the PR #31 review (owner): a message now also refuses the line and
paragraph separators and any Unicode space at either end (note 2), and
the archived-system refusal carries the fixed hint `ai_system_archived`
(note 3). AI systems refuse deletes in TASK-017 (note 1).

### Decisions

1. **The 24 official EU languages** (owner; PLAN open question 4).
2. **Saving publishes**, with no drafts (owner).
3. **One current language per AI system** (owner).
4. **Off is a new version**, `enabled = false` (owner).
5. **The database numbers the versions** (accepted), under a
   per-system transaction lock, with `unique (ai_system_id, version)` as
   the backstop.
6. **A message is one line of plain text, 1 to 500 characters** (accepted):
   no control or format characters (U+200D allowed), no line or paragraph
   separator, no space of any kind at either end, and NFC-normalized.
7. **Nothing is published under an archived AI system** (accepted), not
   even a version that turns the notice off.
8. **No one deletes a version** (accepted), except by deleting its
   organization or AI system; `truncate` is refused too.
9. **The author and time are the database's** (accepted). A write with no
   signed-in user, the service role's included, is refused.
10. **Each version is audited** as `disclosure.published` (accepted), with
    no metadata.
11. **`(organization_id, id)` is unique** (accepted), for verification
    checks (Phase 7).
12. **The language list is mirrored** in `features/disclosures/languages.ts`
    (accepted), and a unit test keeps it equal to the constraint.
13. **A system the caller can't see is refused as if it didn't exist**
    (accepted), with `23503`, before the version is counted. See Security
    considerations.

### Files changed

- `.ai/tasks/TASK-016-disclosures-schema.md` (new): the contract
- `supabase/migrations/20260922190000_disclosures.sql` (new): the table,
  triggers, grants and policies
- `features/disclosures/languages.ts` (new): the 24 language codes
- Tests:
  - `supabase/tests/disclosures.test.sql` (new): 64 pgTAP tests
  - `tests/security/tenant-isolation/disclosures.supabase.ts` (new): 21,
    real database
  - `tests/integration/database/disclosures.supabase.ts` (new): 11, real
    database
  - `tests/unit/disclosures/languages.test.ts` (new): 2

### Security considerations

- **An existence leak, found and fixed before commit.** The version
  trigger counts a system's versions as the caller, through RLS. In the
  first version, a caller naming their own organization and another
  organization's system counted none and tried version 1. That failed with
  a unique violation if the system had a disclosure and a foreign-key error
  if it didn't. So anyone holding a system's ID could learn whether it had
  a disclosure. The Sonnet test subagent reported it instead of accepting
  it. The trigger now first requires the organization and system pair to
  be visible to the caller. Anything else gets `23503`: another
  organization's system, a soft-deleted organization's, an archived one
  elsewhere, one that doesn't exist.
  - Why this over counting as security definer: definer would make the
    count right but would still read and lock before RLS. This way no one
    takes the version lock on a system they can't see.
  - The downside: publishing into another organization now fails with
    `23503`, not RLS's `42501`. TASK-017 must map both to its "not found"
    answer.
- No update or delete grant. The update trigger refuses even the service
  role and the table owner. pgTAP checks column grants with
  `has_any_column_privilege`, and pins the policies to exactly select and
  insert.
- The message is stored as text and nothing in this task renders it. The
  audit row carries no metadata, so customer text stays out of the log.
- `created_by` has no foreign key, like the audit log's actor, so the
  history outlives the user.

### Tests

- Required by the contract: all covered.
- Mutation checks, each applied to the live database and then reset:
  - no update trigger: pgTAP fails, and the service-role update test fails;
  - an update grant and policy on `message`: pgTAP fails (the trigger
    still blocks the API, so only the grant checks catch it; that check
    first used `has_table_privilege`, which misses column grants, and was
    fixed);
  - no audit trigger: 1 real-database test and pgTAP fail;
  - no archived-system check: 1 real-database test and pgTAP fail;
  - no visibility check on the pair: 4 security tests fail;
  - no version lock: the concurrency test (8 publishes at once) failed on
    3 runs out of 3;
  - a writer's own `version`, or `created_by`, kept: pgTAP fails (users
    have no grant on either column, so the API can't reach it);
  - no NFC or format-character check: pgTAP fails;
  - the message check without the separators and end spaces (PR #31
    review): 5 pgTAP tests fail;
  - the archived refusal without its hint: 1 pgTAP and 1 real-database
    test fail.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **For TASK-017's contract** (PR #31 review):
  - `23503` and `42501` from a publish both mean "not found";
  - the archived system is `23514` with hint `ai_system_archived`;
  - `lib/validation/text.ts` mirrors the message rules, U+2028, U+2029
    and the end spaces included;
  - the migration on `ai_systems`: refuse deletes unless the organization
    is being deleted (note 1), with the owed NFC check.

- **This PR has a migration.** Supabase's "Deploy to production" applies
  it on merge. It only adds a table; no existing table changes.
- **No code reads the table yet.** TASK-017 (the versioning service) and
  TASK-018 (the screen) come next. The migration ships first, as the rule
  for new columns asks.
- **Phase 6 and the verifier must check the AI system's status too.** An
  archived system keeps its disclosure history.
- **Write-tool note:** the Write tool decoded the `\u` escapes in the
  format-character pattern into invisible characters. Postgres read them
  the same way, so the tests passed. The pattern was replaced with the
  exact escaped text from `ai_systems`, and a scan of every new file finds
  no control or format characters.
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on `ai_systems` or `organizations` (this one touches
  neither); TASK-019 must check `isPublicDeploymentId` first, require both
  statuses active, and not assume a restore issues a new ID.

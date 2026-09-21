## Handoff

### Summary

Addresses the independent review of PR #17. Two fixes to the last-owner
trigger, two test fixes, and the owner's acceptances recorded.

### Findings and what was done

1. **The lock was too strong.** The owner check took `for update` on the
   organization row. That blocks the `for key share` lock every membership
   insert takes through its foreign key. Now `for no key update`.
   - Why it's safe: two owner checks still conflict with each other, so the
     race protection is unchanged.
   - Measured locally, with an owner change holding its lock for 3 s: an
     insert waited 2,546 ms under the old lock and 313 ms under the new one.
     313 ms is the `docker exec` overhead alone.
2. **Repeatable read defeated the check. Reproduced, and fixed.** Two
   `psql` sessions demoted each other at once under each isolation level.
   Results before the fix:

   | Isolation level | Before the fix                                |
   | --------------- | --------------------------------------------- |
   | read committed  | 1 owner left                                  |
   | serializable    | 1 owner left; Postgres aborts one transaction |
   | repeatable read | **0 owners left**                             |

   The check now raises `25000` under repeatable read. After the fix,
   repeatable read leaves both owners in place.
   - Why refuse rather than make repeatable read work: the other way is to
     have the trigger write to the organization row. That forces a
     serialization failure, but it also bumps `updated_at` on every owner
     change and hides a write inside a check.
   - Why only repeatable read: the Data API runs at read committed, and
     serializable was shown safe above, so neither is blocked.
   - Downside: a future caller at repeatable read gets an error and must
     retry at another level.

3. **The race test was lucky 2 runs in 3.** It now runs 20 fresh races.
   Without the lock it fails 3 runs out of 3 (below). With it, it passes.
   - Chance of a missed regression: about 0.03%, if each race independently
     exposes a missing lock 1 time in 3.
   - Rejected: a deterministic test with two held-open transactions. It needs
     a new database-client dependency.
4. **Integrations:** nothing in the repository to change. See the owner
   actions at the end.
5. **Acceptances:** the TASK-004 handoff now carries the owner's markers on
   its three open items, as the owner approved in chat on 2026-09-21.
6. **No test for leaving.** Added "a member leaves by deleting their own
   membership".
7. **TASK-007 note:** slug enumeration and reserved slugs are recorded as
   open questions for the owner in the TASK-007 contract.

The fixes are a new migration, `20260921130000_…`. The merged migration is
untouched, because a hosted database may already have applied it (review
finding 4).

### Files changed

- `supabase/migrations/20260921130000_owner_check_lock_and_isolation.sql`
  (new)
- `tests/integration/database/memberships.supabase.ts`: 20 races
- `tests/security/tenant-isolation/organizations.supabase.ts`: the leaving
  test
- `.ai/tasks/TASK-004a-organizations-review-follow-ups.md` (new)
- `.ai/tasks/TASK-007-organization-creation.md`: open questions
- `.ai/handoffs/TASK-004-handoff.md`: acceptances

### Security considerations

- No policy, grant or schema changed. Only the trigger function body was
  replaced, and it keeps `security definer`, `search_path = ''` and its
  revoked `execute`.
- Refusing under repeatable read fails closed: the owner change does not
  happen.

### Commands run

- `supabase db reset`: applied all three migrations.
- The two-session isolation reproduction (scratch `psql` scripts, not
  committed): the results in finding 2.
- The insert-wait measurement, old lock against new: the results in
  finding 1.
- Mutation checks, run on the live database and followed by a reset:
  - dropping the self-leave clause from the delete policy fails the new
    leaving test;
  - removing the lock fails the 20-race test, 3 runs out of 3.
- `pnpm test:supabase`: 50 passed.
- `pnpm typecheck`, `pnpm lint` and `pnpm format:check`: passed, with the
  owner's untracked `CODEX-SECURITY.md` set aside and restored (hash
  verified).
- `pnpm test`: 632 passed.
- `pnpm build`: passed, run with the local environment through
  `scripts/local-env.mjs`.

### Remaining concerns

- The repeatable-read guard and the lock strength are proven by the manual
  `psql` reproductions above, not by a committed test. PostgREST cannot set
  an isolation level or hold a transaction open.

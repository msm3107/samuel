## Handoff

### Summary

The real-Supabase browser suite now signs in once per run for the specs
that only need a signed-in user.

- A setup project, `session`, signs in a new user, checks the empty
  dashboard, and saves the session to `tests/e2e/.auth/` (ignored by git).
- The dashboard spec and the sign-in spec's cookie test load it into their
  own browser contexts.
- A run now sends 3 sign-in emails instead of 4, and the count no longer
  grows with each new dashboard spec.

The rate limits are unchanged. Two decisions are the owner's (Mikołaj
Smoliniec, 2026-09-22); four are proposed by the implementer and await the
owner.

### Decisions

1. **The dashboard specs and the cookie test share the sign-in** (owner).
   The two tests of the link itself still use real links.
2. **One user, an organization per spec file** (owner). The empty-dashboard
   check moved into the setup.
3. **A fresh user and session every run**, never an old file: past an hour,
   refresh-token reuse detection would revoke a shared session.
4. **The session is opted into per context**, so every other spec starts
   from an empty browser.
5. **Saved under `tests/e2e/.auth/`, ignored by git**: a local, throwaway
   user's session, rewritten each run.
6. **The rules for sharing it** (never sign out; stay inside your own
   organization) are written in `tests/e2e/support/shared-session.ts`.

### Files changed

- `.ai/tasks/TASK-015a-shared-e2e-session.md` (new): the contract
- `playwright.supabase.config.ts`: the `session` setup project, which the
  specs depend on
- `tests/e2e/shared-session.supabase.setup.ts` (new): signs in once
- `tests/e2e/support/shared-session.ts` (new): the saved session's path,
  and the rules
- `tests/e2e/dashboard/ai-systems.supabase.spec.ts`: loads the shared
  session instead of signing in; the empty-dashboard check moved to the
  setup
- `tests/e2e/auth/sign-in.supabase.spec.ts`: the cookie test starts from
  the shared session
- `.gitignore`: `tests/e2e/.auth/`

### Security considerations

- No rate limit, security setting or application code changed.
- The saved session belongs to a throwaway user of the local instance and
  is never committed.
- The sign-in spec's link tests still request and follow real links, so
  the sign-in path itself is covered as before.

### Tests

- `pnpm test:e2e:supabase`: 8 pass (the setup and 7 tests), and Mailpit
  shows the run sent exactly 3 sign-in emails: the shared session's and
  the two link tests'.
- Mutation check: the dashboard spec without the shared session fails its
  first check. Restored, it passes again against a user that already had
  the previous run's organization, so the per-file scoping holds.
- The stub config still lists only its own 18 tests; the setup file isn't
  picked up there.

### Commands run

See the PR. Each gate was run with the owner's untracked
`CODEX-SECURITY.md` set aside and restored, and its hash verified.

### Remaining concerns

- **Two full runs inside ten minutes still hit the limit** (6 links against
  5). This task stops growth; it doesn't make back-to-back runs possible.
  To rerun one spec quickly, `--no-deps` reuses the last saved session
  (valid for an hour) and asks for no link.
- **A CI retry of the setup asks for one more link.**
- **Owed from earlier tasks, unchanged:** the database NFC check with the
  next migration on `ai_systems` or `organizations`; TASK-019 must check
  `isPublicDeploymentId` first, require both statuses active, and not
  assume a restore issues a new ID.

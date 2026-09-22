# TASK-015a — One shared sign-in for the browser tests

## Objective

Make the real-Supabase browser suite sign in once per run for the specs
that only need a signed-in user, so the number of magic links a run asks
for stays fixed as Phase 5 adds spec files. Decided on the PR #29 review
(note 1; Mikołaj Smoliniec, project owner, 2026-09-22), after two runs of
that PR failed on the magic-link rate limit.

## Owner agent

Test infrastructure

## Dependencies

TASK-003c (the magic-link limits), TASK-010 and TASK-015 (the dashboard
spec).

## Allowed files

- playwright.supabase.config.ts
- tests/e2e/**
- .gitignore (the saved session)

## Forbidden files

- Everything outside tests and the Playwright config. In particular the
  rate limits (TASK-003c) stay as they are: they are a reviewed security
  setting, and raising them for tests was rejected on the PR #29 review.

## Decisions

Chosen by Mikołaj Smoliniec (project owner), 2026-09-22:

- **The dashboard specs and the cookie test share the sign-in.** A setup
  project, `session`, signs in once per run and saves the session with
  Playwright's `storageState`; the specs that need a signed-in user load it
  into their own browser context. The sign-in spec keeps a real link for
  the two tests that test the link itself (it lands on the dashboard; it is
  refused in another browser). Its third test, that the dashboard closes
  once the cookies are gone, starts from the shared session in a context of
  its own and clears only that context. A run asks for 3 links instead of
  4, and still 3 however many dashboard specs are added. Rejected: leaving
  the sign-in spec as it was (4 links a run, one more than needed).
- **One user; each spec file works in its own organization.** Each file
  creates an organization with a unique name and looks only inside it. The
  one check that needs a brand-new user, the empty dashboard ("You are not
  in any organization yet"), moves into the setup, right after sign-in and
  before any spec creates anything. Rejected: one user per spec file,
  which costs a link per file again.

Proposed by the implementer; all four accepted on the PR #30 review. Accepted by Mikołaj Smoliniec (project owner), 2026-09-22.

1. **A fresh user and session every run.** The setup always runs first
   (the specs depend on it) and signs in a new address. An old saved
   session is never reused: the session lasts an hour, and past that two
   contexts refreshing the same token more than ten seconds apart would
   trip refresh-token reuse detection and revoke it.
2. **Only specs that ask for the session get it.** It is loaded per
   context, not set for the whole project, so the link tests and any future
   spec start from an empty browser unless they opt in.
3. **Saved to `tests/e2e/.auth/`, ignored by git.** It holds a session for
   a throwaway user of the local instance only, rewritten each run.
4. **The rules for a spec that shares it are written beside the file's
   path** (`tests/e2e/support/shared-session.ts`): never sign out (that
   would revoke it for every other spec; a test about signing out signs in
   for itself), and work only inside an organization of its own.

## Amendment: the PR #30 review

- **A stale saved session stops with its reason** (note 1; chosen by
  Mikołaj Smoliniec, project owner, 2026-09-22). A rerun with `--no-deps`
  reuses the last saved session; once that is over 50 minutes old (short
  of its hour), `sharedSession()` stops the spec with "Shared session is
  stale; rerun without --no-deps" instead of letting it be sent to sign-in,
  which would read like an app bug. A normal run writes the file just
  before, so it always passes. The dashboard spec's `afterAll` no longer
  adds a second error when its context was never created.

## Invariants

- No rate limit, security setting or application file changes.
- A spec sharing the session never signs out.
- The tests that exercise the magic link itself still request and follow a
  real link.

## Acceptance criteria

- `pnpm test:e2e:supabase` passes, and a run sends 3 sign-in emails.
- The stub suite (`pnpm test:e2e`) is unaffected.
- A dashboard spec without the shared session fails, showing it really
  depends on it.
- Typecheck, lint, format, and tests pass.

## Limits

- The limit is five links per network every ten minutes, so two full runs
  inside ten minutes (6 links) still hit it. What this task fixes is growth:
  more spec files no longer mean more links.
- A CI retry of the setup asks for one more link.

import path from "node:path";

/**
 * Where the browser specs' shared sign-in is saved (TASK-015a). The
 * `session` setup project in playwright.supabase.config.ts signs in once per
 * run and writes it here; a spec that needs a signed-in user loads it into
 * its own context with `storageState`.
 *
 * It holds a session for a throwaway user of the local instance, rewritten
 * every run, and is ignored by git.
 *
 * Rules for a spec that uses it:
 *
 * - Never sign out: that revokes the session for every other spec. A test
 *   about signing out gets its own sign-in.
 * - Create its own organization, with a unique name, and look only inside
 *   it: other specs' organizations are on the same dashboard.
 * - The session lasts an hour (`jwt_expiry` in supabase/config.toml), far
 *   longer than a run. Past that, two contexts refreshing the same token
 *   more than ten seconds apart would trip refresh-token reuse detection
 *   and revoke it, so the setup signs in afresh on every run rather than
 *   reusing an old file.
 */
// `__dirname`, not `import.meta`: Playwright loads specs as CommonJS.
export const SHARED_SESSION_FILE = path.join(
  __dirname,
  "..",
  ".auth",
  "shared-session.json",
);

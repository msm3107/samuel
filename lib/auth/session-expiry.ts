import { combineChunks, stringFromBase64URL } from "@supabase/ssr";

import { serverEnv } from "@/lib/env/server-env";

/**
 * Whether auth-js would refresh this request's session before anything can be
 * rendered:
 *
 * - `none`: no session auth-js would accept — no cookie, or one it cannot
 *   read. auth-js treats an unreadable value as absent and makes no request.
 * - `valid`: a session whose access token is not yet within auth-js's refresh
 *   margin.
 * - `refresh`: a session auth-js would refresh now.
 *
 * Read from the cookie alone, with no network call, so the proxy can consume
 * the refresh allowance before GoTrue is asked (TASK-003f). It must agree with
 * auth-js exactly: every difference is either a refresh that skips the limit
 * or a limit spent on a request that costs GoTrue nothing (the owner's review
 * of PR #14). So the cookie is reassembled and decoded with `@supabase/ssr`'s
 * own functions, and validated and timed as auth-js's `__loadSession` does.
 * The cookie is not trusted for anything else.
 */
export type SessionRefreshState = "none" | "valid" | "refresh";

/**
 * auth-js refreshes an access token this long before it expires
 * (`EXPIRY_MARGIN_MS` in `@supabase/auth-js`, 3 × 30 s). A token inside the
 * margin is refreshed even though it has not expired.
 */
export const AUTH_JS_EXPIRY_MARGIN_MS = 90 * 1000;

/** What `@supabase/ssr` prefixes a base64url-encoded cookie value with. */
const BASE64_PREFIX = "base64-";

/** Mirrors `@supabase/ssr`: `sb-<first hostname label>-auth-token`. */
export function sessionCookieName(): string {
  const { hostname } = new URL(serverEnv().SUPABASE_URL);
  return `sb-${hostname.split(".")[0]}-auth-token`;
}

export async function sessionRefreshState(
  cookies: { getAll: () => { name: string; value: string }[] },
  nowMs: number = Date.now(),
): Promise<SessionRefreshState> {
  const session = await readStoredSession(cookies.getAll());
  if (!isValidSession(session)) {
    return "none";
  }

  // As auth-js: a falsy expiry never counts as expired, and the arithmetic
  // coerces whatever the cookie holds.
  const expiresAt: unknown = session.expires_at;
  if (!expiresAt) {
    return "valid";
  }
  return Number(expiresAt) * 1000 - nowMs < AUTH_JS_EXPIRY_MARGIN_MS
    ? "refresh"
    : "valid";
}

/**
 * The stored session as auth-js would read it: `@supabase/ssr` reassembles the
 * chunks (`combineChunks`: the whole cookie if it has a value, otherwise
 * `<name>.0`, `<name>.1`, … up to the first missing index), decodes a
 * `base64-` value with `stringFromBase64URL`, and auth-js parses the JSON.
 * Anything that fails along the way is no session.
 */
async function readStoredSession(
  cookies: { name: string; value: string }[],
): Promise<unknown> {
  const name = sessionCookieName();
  const chunked = await combineChunks(
    name,
    (chunkName) => cookies.find((cookie) => cookie.name === chunkName)?.value,
  );
  if (!chunked) {
    return null;
  }

  let json = chunked;
  if (chunked.startsWith(BASE64_PREFIX)) {
    try {
      json = stringFromBase64URL(chunked.slice(BASE64_PREFIX.length));
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/** auth-js's `_isValidSession`: an object with all three keys present. */
function isValidSession(session: unknown): session is {
  access_token: unknown;
  refresh_token: unknown;
  expires_at: unknown;
} {
  return (
    typeof session === "object" &&
    session !== null &&
    "access_token" in session &&
    "refresh_token" in session &&
    "expires_at" in session
  );
}

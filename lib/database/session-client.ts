import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

import {
  hardenCookieOptions,
  PKCE_FLOW_OPTIONS,
} from "@/lib/database/session-cookie-options";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";

/**
 * A cookie write that removes rather than sets: an empty value, a zero
 * maximum age, or an expiry in the past.
 */
function isRemoval(value: string, options: CookieOptions) {
  return (
    value === "" ||
    options.maxAge === 0 ||
    (options.expires !== undefined &&
      new Date(options.expires).getTime() <= Date.now())
  );
}

function writeCookies(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  cookiesToSet: { name: string; value: string; options: CookieOptions }[],
) {
  try {
    for (const { name, value, options } of cookiesToSet) {
      cookieStore.set(name, value, hardenCookieOptions(options));
    }
  } catch (error) {
    // Server components cannot write cookies. The proxy refreshes the
    // session before rendering, so a refresh here is a race rather than
    // a lost login — but it is logged, because a steady stream of these
    // means the proxy is not refreshing. Names only: values are tokens.
    logger.warn(
      {
        event: "session_cookie_write_skipped",
        errorName: error instanceof Error ? error.name : "unknown",
        cookieNames: cookiesToSet.map(({ name }) => name),
      },
      "Session cookies could not be written in this rendering context",
    );
  }
}

/**
 * The signed-in user's client for server components, route handlers, and
 * server actions. Row-level security applies. Create one per request; a client
 * shared across requests would carry one user's session into another's.
 *
 * Holds the anon key only, so it confers no privilege beyond the session in
 * the request's cookies.
 *
 * Every cookie auth-js asks for is written, removals included, which is what
 * signing in and signing out need. Code that only *resolves* a session uses
 * `createResolvingSessionClient` instead, so an auth-server hiccup cannot
 * delete anyone's session (TASK-003i).
 */
export async function createSessionClient() {
  const cookieStore = await cookies();
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = serverEnv();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: PKCE_FLOW_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => writeCookies(cookieStore, cookiesToSet),
    },
  });
}

/**
 * The same client for code that resolves a session — `requireSession` in a
 * route handler or server action — with one difference: a batch that only
 * removes the session is held rather than written.
 *
 * auth-js deletes the session after any non-retryable refresh failure, a 429
 * caused by other people's traffic included, so writing that removal straight
 * out would sign someone out over an auth-server hiccup (review finding F2).
 * The caller applies the held removals once it knows the session really was
 * refused, with `applyHeldRemovals`.
 *
 * A batch that writes a new session and removes its stale chunks is applied at
 * once: holding those removals would leave chunks that corrupt the next read.
 */
export async function createResolvingSessionClient() {
  const cookieStore = await cookies();
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = serverEnv();
  const heldRemovals: {
    name: string;
    value: string;
    options: CookieOptions;
  }[] = [];

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: PKCE_FLOW_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        const removesOnly = cookiesToSet.every(({ value, options }) =>
          isRemoval(value, options),
        );
        if (removesOnly) {
          heldRemovals.push(...cookiesToSet);
          return;
        }
        writeCookies(cookieStore, cookiesToSet);
      },
    },
  });

  return {
    supabase,
    /** Writes the removals auth-js asked for, once the session is known bad. */
    applyHeldRemovals: () => {
      if (heldRemovals.length > 0) {
        writeCookies(cookieStore, heldRemovals);
        heldRemovals.length = 0;
      }
    },
  };
}

/**
 * `@supabase/ssr` splits a session across at most this many cookies. Expiring
 * the whole range costs a few bytes of response header and covers chunks this
 * request cannot see.
 */
const MAX_SESSION_COOKIE_CHUNKS = 5;

/**
 * Expires the session cookie and its chunks by name, whether or not this
 * request can see them. Sign-out uses it so a browser can always be signed
 * out: auth-js clears only what it can read, and the proxy hides the session
 * from a request whose refresh is over the limit (TASK-003f), leaving a cookie
 * in the browser that nothing server-side would otherwise clear (TASK-003i).
 *
 * Cookies that merely share the prefix — the PKCE verifiers of a sign-in in
 * progress — are not touched here.
 */
export function removeSessionCookies(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  sessionCookieName: string,
) {
  const names = [
    sessionCookieName,
    ...Array.from(
      { length: MAX_SESSION_COOKIE_CHUNKS },
      (_unused, index) => `${sessionCookieName}.${index}`,
    ),
    ...cookieStore
      .getAll()
      .map(({ name }) => name)
      .filter(
        (name) =>
          name.startsWith(`${sessionCookieName}.`) &&
          /^\d+$/.test(name.slice(sessionCookieName.length + 1)),
      ),
  ];

  writeCookies(
    cookieStore,
    [...new Set(names)].map((name) => ({
      name,
      value: "",
      options: { maxAge: 0 },
    })),
  );
}

import { serverEnv } from "@/lib/env/server-env";

/**
 * Reads and rewrites the session cookie `@supabase/ssr` stores, which may be
 * split into `.0`, `.1`, … chunks when the session is large. Lets a test age a
 * real session or replay a stale copy of it.
 */

export function sessionCookieName() {
  const { hostname } = new URL(serverEnv().SUPABASE_URL);
  return `sb-${hostname.split(".")[0]}-auth-token`;
}

function isSessionCookie(name: string) {
  const base = sessionCookieName();
  return name === base || new RegExp(`^${base}\\.\\d+$`).test(name);
}

function chunkIndex(name: string) {
  const suffix = name.slice(sessionCookieName().length + 1);
  return suffix === "" ? -1 : Number(suffix);
}

export type StoredSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  [key: string]: unknown;
};

export function readSession(jar: Map<string, string>): StoredSession {
  const parts = [...jar.entries()]
    .filter(([name]) => isSessionCookie(name))
    .sort(([a], [b]) => chunkIndex(a) - chunkIndex(b))
    .map(([, value]) => value);

  const encoded = parts.join("");
  if (!encoded.startsWith("base64-")) {
    throw new Error("No session cookie in the jar");
  }
  return JSON.parse(
    Buffer.from(encoded.slice("base64-".length), "base64url").toString("utf8"),
  ) as StoredSession;
}

/** Replaces the session cookie (and any chunks) with `session`, unchunked. */
export function writeSession(jar: Map<string, string>, session: StoredSession) {
  for (const name of [...jar.keys()]) {
    if (isSessionCookie(name)) {
      jar.delete(name);
    }
  }
  jar.set(
    sessionCookieName(),
    `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
  );
}

export function cookiesOf(jar: Map<string, string>) {
  return [...jar.entries()].map(([name, value]) => ({ name, value }));
}

import { z } from "zod";

import { serverEnv } from "@/lib/env/server-env";

/**
 * Whether the proxy would have to refresh this request's session before
 * anything can be rendered:
 *
 * - `none`: no session cookie at all.
 * - `valid`: an access token that has not expired.
 * - `refresh`: an access token that has expired, so auth-js would go to the
 *   auth server for a new one.
 *
 * A cookie that cannot be decoded counts as `none`: auth-js treats an
 * undecodable value as no session at all and makes no request for it, so it
 * must not spend anyone's refresh allowance.
 *
 * Read from the cookie alone, with no network call, so the proxy can consume
 * the refresh allowance before GoTrue is asked (TASK-003f). The cookie is not
 * trusted for anything else: it decides only whether a request costs a refresh.
 */
export type SessionRefreshState = "none" | "valid" | "refresh";

const storedSessionSchema = z.object({ expires_at: z.number().int() });

/** Mirrors `@supabase/ssr`: `sb-<first hostname label>-auth-token`. */
export function sessionCookieName(): string {
  const { hostname } = new URL(serverEnv().SUPABASE_URL);
  return `sb-${hostname.split(".")[0]}-auth-token`;
}

export function sessionRefreshState(
  cookies: { getAll: () => { name: string; value: string }[] },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionRefreshState {
  const value = readSessionCookie(cookies.getAll());
  if (value === null) {
    return "none";
  }

  const session = storedSessionSchema.safeParse(decodeSession(value));
  if (!session.success) {
    return "none";
  }
  return session.data.expires_at > nowSeconds ? "valid" : "refresh";
}

/**
 * The session cookie, reassembled from the chunks `@supabase/ssr` writes when
 * it is too large for one cookie (`<name>.0`, `<name>.1`, …). The PKCE
 * verifier cookies share the prefix but never this shape, so they are left
 * alone.
 */
function readSessionCookie(
  cookies: { name: string; value: string }[],
): string | null {
  const name = sessionCookieName();
  const whole = cookies.find((cookie) => cookie.name === name);
  if (whole) {
    return whole.value;
  }

  const chunks = cookies
    .flatMap((cookie) => {
      const suffix = cookie.name.startsWith(`${name}.`)
        ? cookie.name.slice(name.length + 1)
        : "";
      return /^\d+$/.test(suffix)
        ? [{ index: Number(suffix), value: cookie.value }]
        : [];
    })
    .sort((left, right) => left.index - right.index);

  return chunks.length === 0
    ? null
    : chunks.map((chunk) => chunk.value).join("");
}

function decodeSession(value: string): unknown {
  const json = value.startsWith("base64-")
    ? decodeBase64(value.slice("base64-".length))
    : value;
  if (json === null) {
    return null;
  }
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

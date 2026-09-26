import { NextResponse, type NextRequest } from "next/server";

import { SessionLookupError } from "@/lib/auth/errors";
import { isDashboardPath, SIGN_IN_PATH } from "@/lib/auth/protected-routes";
import { resolveSessionUser } from "@/lib/auth/resolve-session-user";
import {
  sessionCookieName,
  sessionRefreshState,
} from "@/lib/auth/session-expiry";
import { createProxySessionClient } from "@/lib/database/proxy-session-client";
import { isDevelopment } from "@/lib/env/runtime-mode";
import { STRICT_TRANSPORT_SECURITY } from "@/lib/http/hsts";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";
import { requestNetwork } from "@/lib/security/client-ip";
import {
  consumeRateLimit,
  GLOBAL,
  RateLimitUnavailableError,
} from "@/lib/security/rate-limit";

const NONCE_HEADER = "x-nonce";

/**
 * Cloudflare Turnstile's challenge runs in a frame from this origin. Every page
 * allows it, not only /sign-in (TASK-003g): a client-side navigation keeps the
 * policy of the page it started from, and sign-out and the dashboard's session
 * redirect both reach /sign-in that way. Its script needs no `script-src`
 * entry, because the application's own nonce-trusted code inserts it and
 * 'strict-dynamic' extends trust to scripts inserted that way.
 */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Next.js injects inline bootstrap scripts, so a `script-src 'self'` policy
 * cannot be used verbatim. A per-request nonce plus 'strict-dynamic' keeps the
 * policy as strict as rule 13 intends while letting the framework boot.
 */
function buildContentSecurityPolicy(nonce: string) {
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // The development bundler evaluates generated code; production does not.
    isDevelopment ? "'unsafe-eval'" : "",
  ].filter(Boolean);

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${TURNSTILE_ORIGIN}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    isDevelopment ? "" : "upgrade-insecure-requests",
  ].filter(Boolean);

  return directives.join("; ");
}

function applySecurityHeaders(
  response: NextResponse,
  contentSecurityPolicy: string,
) {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  );

  if (!isDevelopment) {
    // Also set by next.config.ts for every path (PR #36 review, note 1).
    // Kept here because the proxy returns some responses itself — the
    // sign-in redirect and the session-unavailable 503 — and those do not
    // pass through the framework's header pipeline.
    response.headers.set(
      "Strict-Transport-Security",
      STRICT_TRANSPORT_SECURITY,
    );
  }
}

/**
 * Dashboard routes are gated here, not only in the dashboard layout: Next.js
 * can render a child segment without re-running the layouts above it (client
 * navigation, and RSC requests naming their router state), so the layout
 * alone is not a per-request guarantee.
 */
/**
 * Whether this request may spend a token refresh (TASK-003f). Every expired
 * session makes the proxy refresh it from this application's own address, and
 * GoTrue counts refreshes per client IP, so anonymous junk cookies could
 * exhaust that budget and have everyone else refused (review finding F2).
 *
 * Only requests that would actually refresh consume an allowance, so a valid
 * session costs nothing. Past a limit, or when the limiter cannot answer, the
 * session is unverifiable: no auth-server call, and no cookie removed.
 */
async function mayRefreshSession(request: NextRequest): Promise<boolean> {
  if ((await sessionRefreshState(request.cookies)) !== "refresh") {
    return true;
  }

  try {
    if (
      !(await consumeRateLimit(
        "sessionRefreshNetwork",
        requestNetwork(request.headers),
      ))
    ) {
      logger.warn({ event: "rate_limited", limit: "sessionRefreshNetwork" });
      return false;
    }
    if (!(await consumeRateLimit("sessionRefreshGlobal", GLOBAL))) {
      // Once per window, so the attacker does not decide the error volume.
      if (await consumeRateLimit("sessionRefreshCeilingAlert", GLOBAL)) {
        logger.error({ event: "session_refresh_ceiling_reached" });
      }
      return false;
    }
  } catch (error) {
    if (!(error instanceof RateLimitUnavailableError)) {
      throw error;
    }
    logger.error({ event: "session_refresh_limiter_unavailable" });
    return false;
  }
  return true;
}

async function resolveProxySessionState(
  supabase: ReturnType<typeof createProxySessionClient>["supabase"],
  options: { hadStoredSession: boolean },
): Promise<
  | { state: "signed-in" | "signed-out" }
  | { state: "unverifiable"; error: SessionLookupError }
> {
  try {
    const resolution = await resolveSessionUser(supabase.auth, options);
    return {
      state: resolution.status === "authenticated" ? "signed-in" : "signed-out",
    };
  } catch (error) {
    if (error instanceof SessionLookupError) {
      return { state: "unverifiable", error };
    }
    throw error;
  }
}

/**
 * Enough to tell an auth outage (5xx, network) from a client-induced local
 * failure (status 0 with a malformed token) without logging the cause's
 * message, which for a rejected header can contain the token itself.
 */
function describeLookupFailure(error: SessionLookupError) {
  const { cause } = error;
  if (typeof cause !== "object" || cause === null) {
    return { causeName: "none" };
  }
  const causeName = cause instanceof Error ? cause.name : "unknown";
  const causeStatus =
    "status" in cause && typeof cause.status === "number"
      ? cause.status
      : undefined;
  return causeStatus === undefined ? { causeName } : { causeName, causeStatus };
}

/**
 * Rewrites the forwarded `cookie` header without the session cookie or its
 * chunks. Only this request's view changes: no `Set-Cookie` is written, so the
 * browser keeps everything, and the PKCE verifier and flow-ticket cookies stay
 * put for a sign-in that is still in progress.
 */
function withoutSessionCookies(request: NextRequest, headers: Headers) {
  const name = sessionCookieName();
  const kept = request.cookies
    .getAll()
    .filter(
      (cookie) =>
        cookie.name !== name &&
        !(
          cookie.name.startsWith(`${name}.`) &&
          /^\d+$/.test(cookie.name.slice(name.length + 1))
        ),
    );

  if (kept.length === 0) {
    headers.delete("cookie");
    return;
  }
  headers.set(
    "cookie",
    kept.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
  );
}

function redirectToSignIn() {
  // Built from configuration rather than the request's Host header, and with
  // no trace of the requested path, so the redirect reveals nothing and cannot
  // be steered to another origin. 303 so a POST whose session expired is
  // followed by a GET, never by re-sending its body to sign-in.
  const response = NextResponse.redirect(
    new URL(SIGN_IN_PATH, serverEnv().NEXT_PUBLIC_APP_URL),
    303,
  );
  // A cached redirect would bounce signed-in users too.
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * The session could not be verified, so the dashboard is not served — but the
 * visitor is not sent to sign-in either, which would loop a signed-in user
 * through an auth outage. A client can also cause this (a cookie holding a
 * token that is not a valid header value never reaches the auth server), so it
 * must fail closed here rather than trust the layout to catch it. The body is
 * the same for every dashboard path.
 */
function sessionUnavailable(error: SessionLookupError) {
  const reference = `err_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  logger.warn({
    event: "proxy_session_lookup_failed",
    code: error.code,
    reference,
    ...describeLookupFailure(error),
  });

  return new NextResponse(
    `Something went wrong. Please try again.\nReference: ${reference}\n`,
    {
      status: 503,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    },
  );
}

export default async function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);

  // Before the session client exists: creating one subscribes to auth events,
  // which makes auth-js load and refresh the session in the background
  // (@supabase/ssr's createServerClient). Past the limit that refresh must
  // never start, and nothing may remove the session's cookies.
  const mayRefresh = await mayRefreshSession(request);

  // Must run before request.headers is copied below: a token refresh rewrites
  // the request's cookies, and server components must receive the new ones.
  const { supabase, applySessionCookies } = mayRefresh
    ? createProxySessionClient(request)
    : { supabase: null, applySessionCookies: () => {} };
  const session = supabase
    ? await resolveProxySessionState(supabase, {
        hadStoredSession:
          (await sessionRefreshState(request.cookies)) !== "none",
      })
    : { state: "unverifiable" as const, error: new SessionLookupError() };
  const isDashboardRequest = isDashboardPath(request.nextUrl.pathname);

  let response: NextResponse;
  if (isDashboardRequest && session.state === "signed-out") {
    response = redirectToSignIn();
  } else if (isDashboardRequest && session.state === "unverifiable") {
    response = sessionUnavailable(session.error);
  } else {
    // Next.js reads the nonce back off the request headers to stamp its own
    // script tags, so the policy is set on both request and response.
    const requestHeaders = new Headers(request.headers);
    if (!mayRefresh) {
      // The refusal has to reach the handlers too: a server action or route
      // handler builds its own session client, and creating one lets auth-js
      // refresh in the background, unmetered. Hiding the session from this
      // request makes that impossible; the browser keeps its cookies, so
      // nobody is signed out and the next request tries again.
      withoutSessionCookies(request, requestHeaders);
    }
    requestHeaders.set(NONCE_HEADER, nonce);
    requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  applySecurityHeaders(response, contentSecurityPolicy);
  // Also on the redirect, so a rejected session's cookies are cleared — but
  // never when the session could not be verified: a 429 or an outage is not
  // evidence the session is invalid, and deleting it would let anyone who can
  // exhaust the auth server's per-IP limit sign other people out.
  applySessionCookies(response, {
    keepExistingSession: session.state === "unverifiable",
  });

  return response;
}

export const config = {
  matcher: [
    // Static assets and the public widget carry no HTML to protect, and the
    // widget is deliberately served without dashboard security headers.
    // Anchored, so only `/widget`, `/widget/…` and `/widget.js` are excluded —
    // not every path that merely starts with "widget".
    //
    // `/api/public/…` is excluded for a different reason (TASK-019a): this
    // proxy exists to refresh sessions and stamp HTML security headers, and
    // on a surface with no session at all it would build a session client
    // per request — which makes auth-js refresh in the background and spends
    // `sessionRefreshNetwork` buckets — while making the response depend on
    // cookies that a shared cache must never see. The public route sets its
    // own `X-Content-Type-Options`. Anchored too, so `/api/publications`
    // keeps its headers.
    "/((?!_next/static/|_next/image|favicon\\.ico$|widget$|widget/|widget\\.js$|api/public/).*)",
  ],
};

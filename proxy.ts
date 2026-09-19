import { NextResponse, type NextRequest } from "next/server";

import { SessionLookupError } from "@/lib/auth/errors";
import { isDashboardPath, SIGN_IN_PATH } from "@/lib/auth/protected-routes";
import { resolveSessionUser } from "@/lib/auth/resolve-session-user";
import { createProxySessionClient } from "@/lib/database/proxy-session-client";
import { isDevelopment } from "@/lib/env/runtime-mode";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";

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
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }
}

/**
 * Dashboard routes are gated here, not only in the dashboard layout: Next.js
 * can render a child segment without re-running the layouts above it (client
 * navigation, and RSC requests naming their router state), so the layout
 * alone is not a per-request guarantee.
 */
async function resolveProxySessionState(
  supabase: ReturnType<typeof createProxySessionClient>["supabase"],
): Promise<
  | { state: "signed-in" | "signed-out" }
  | { state: "unverifiable"; error: SessionLookupError }
> {
  try {
    const resolution = await resolveSessionUser(supabase.auth);
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

  // Must run before request.headers is copied below: a token refresh rewrites
  // the request's cookies, and server components must receive the new ones.
  const { supabase, applySessionCookies } = createProxySessionClient(request);
  const session = await resolveProxySessionState(supabase);
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
    "/((?!_next/static/|_next/image|favicon\\.ico$|widget$|widget/|widget\\.js$).*)",
  ],
};

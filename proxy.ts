import { NextResponse, type NextRequest } from "next/server";

import { isDevelopment } from "@/lib/env/runtime-mode";

const NONCE_HEADER = "x-nonce";

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
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    isDevelopment ? "" : "upgrade-insecure-requests",
  ].filter(Boolean);

  return directives.join("; ");
}

export default function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce);

  // Next.js reads the nonce back off the request headers to stamp its own
  // script tags, so the policy is set on both request and response.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

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

  return response;
}

export const config = {
  matcher: [
    // Static assets and the public widget carry no HTML to protect, and the
    // widget is deliberately served without dashboard security headers.
    "/((?!_next/static|_next/image|favicon.ico|widget|widget.js).*)",
  ],
};

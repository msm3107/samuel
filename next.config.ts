import type { NextConfig } from "next";

import { isDevelopment } from "./lib/env/runtime-mode";
import { STRICT_TRANSPORT_SECURITY } from "./lib/http/hsts";

/**
 * Security headers that never vary per request. The CSP nonce is
 * per-request and is therefore set in proxy.ts instead.
 *
 * These apply to every path the framework serves, `/api/public/…` included,
 * which is what makes them independent of the proxy's matcher (PR #36
 * review, note 1): excluding a path from the proxy must not silently drop a
 * header that has nothing to do with sessions.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Not in development, where the application is served over plain http on
  // loopback and pinning https for the host would be a nuisance to undo.
  // proxy.ts applies the same constant to the responses it returns itself.
  ...(isDevelopment
    ? []
    : [{ key: "Strict-Transport-Security", value: STRICT_TRANSPORT_SECURITY }]),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // The framework version is a free hint to anyone fingerprinting the stack,
  // and nothing depends on the header.
  poweredByHeader: false,

  headers: async () => [{ source: "/:path*", headers: securityHeaders }],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // The framework version is a free hint to anyone fingerprinting the stack,
  // and nothing depends on the header.
  poweredByHeader: false,

  // Security headers that never vary per request live here; the CSP nonce is
  // per-request and is therefore set in proxy.ts instead.
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
        },
      ],
    },
  ],
};

export default nextConfig;

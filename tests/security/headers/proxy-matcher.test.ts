import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";

// The proxy now reaches the rate limiter, a server-only module.
vi.mock("server-only", () => ({}));

import { config } from "@/proxy";

/**
 * The proxy is what sets the CSP and security headers, so any path it does not
 * match ships without them. Only static assets and the public widget may be
 * excluded. Codex review of PR #6, finding F7.
 */
function proxyRuns(path: string) {
  return unstable_doesMiddlewareMatch({
    config,
    url: `http://localhost:3000${path}`,
  });
}

describe("proxy matcher", () => {
  it.each([
    "/",
    "/sign-in",
    "/dashboard",
    "/auth/callback",
    "/api/organizations",
    // Paths that merely start like an excluded one keep their headers.
    "/widget-settings",
    "/widgets",
    "/widget.json",
    "/widget.jsx",
    "/favicon.icon",
    "/_next/staticky",
    "/api/publications",
    "/api/public",
    "/api/publicity/report",
  ])("sets security headers on %s", (path) => {
    expect(proxyRuns(path)).toBe(true);
  });

  it.each([
    "/widget",
    "/widget/",
    "/widget/v1/loader.js",
    "/widget.js",
    "/favicon.ico",
    "/_next/static/chunks/app.js",
    "/_next/image",
    // TASK-019a: the public endpoint has no session to refresh and no HTML
    // to protect, and its answer must not depend on a cookie the proxy
    // would read.
    "/api/public/disclosure/dep_7k2m4qphr6vt3wzc5nxa7jd2fb",
  ])("leaves %s to be served without dashboard headers", (path) => {
    expect(proxyRuns(path)).toBe(false);
  });
});

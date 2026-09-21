import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import proxy from "@/proxy";
import {
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  USER_A,
} from "@/tests/security/auth/support/stub-auth-server";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function policyFor(path: string) {
  installStubAuthServer({ mode: "normal", users: [USER_A] });
  const response = await proxy(
    proxyRequest(path, { cookies: [sessionCookie(USER_A)] }),
  );
  return response.headers.get("content-security-policy") ?? "";
}

describe("security: the Turnstile challenge's frame (TASK-003c, TASK-003g)", () => {
  // Every page, because a client-side navigation to /sign-in (sign-out, the
  // dashboard's session redirect) keeps the policy of the page it left.
  it.each(["/sign-in", "/", "/dashboard", "/auth/callback"])(
    "lets %s frame Cloudflare's challenge and nothing else",
    async (path) => {
      const policy = await policyFor(path);
      expect(policy).toContain("frame-src https://challenges.cloudflare.com;");
      expect(policy.match(/frame-src [^;]*/g)).toEqual([
        "frame-src https://challenges.cloudflare.com",
      ]);
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
    },
  );

  it.each(["/sign-in", "/dashboard"])(
    "adds no host to script-src on %s, which stays nonce and 'strict-dynamic' only",
    async (path) => {
      const policy = await policyFor(path);
      const scriptSrc = /script-src ([^;]*)/.exec(policy)?.[1] ?? "";

      expect(scriptSrc).toMatch(
        /^'self' 'nonce-[0-9a-f]{32}' 'strict-dynamic'$/,
      );
    },
  );
});

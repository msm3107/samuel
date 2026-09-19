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

describe("security: the Turnstile challenge is allowed on the sign-in page only (TASK-003c)", () => {
  it("lets /sign-in frame Cloudflare's challenge", async () => {
    expect(await policyFor("/sign-in")).toContain(
      "frame-src https://challenges.cloudflare.com",
    );
  });

  it.each(["/", "/dashboard", "/sign-in/other", "/auth/callback"])(
    "keeps frames at the default 'self' on %s",
    async (path) => {
      const policy = await policyFor(path);
      expect(policy).not.toContain("frame-src");
      expect(policy).not.toContain("challenges.cloudflare.com");
      expect(policy).toContain("default-src 'self'");
    },
  );

  it("adds no host to script-src, which stays nonce and 'strict-dynamic' only", async () => {
    const policy = await policyFor("/sign-in");
    const scriptSrc = /script-src ([^;]*)/.exec(policy)?.[1] ?? "";

    expect(scriptSrc).toMatch(/^'self' 'nonce-[0-9a-f]{32}' 'strict-dynamic'$/);
  });
});

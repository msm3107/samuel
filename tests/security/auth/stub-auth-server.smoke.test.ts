import { afterEach, describe, expect, it, vi } from "vitest";

import proxy from "@/proxy";

import {
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  USER_A,
} from "./support/stub-auth-server";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stub auth server", () => {
  it("is consulted by the real Supabase client for a well-formed session cookie", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A],
    });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );

    expect(requests).toContainEqual({
      method: "GET",
      path: "/auth/v1/user",
      authorization: `Bearer ${USER_A.accessToken}`,
    });
    expect(response.status).toBe(200);
  });
});

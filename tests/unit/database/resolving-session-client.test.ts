import { afterEach, describe, expect, it, vi } from "vitest";

const cookieStore = vi.hoisted(() => ({
  getAll: vi.fn(() => [] as { name: string; value: string }[]),
  set: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/logger", () => ({
  logger: { warn: vi.fn() },
}));

vi.mock("@/lib/env/server-env", () => ({
  serverEnv: () => ({
    SUPABASE_URL: "http://env-module.supabase.test",
    SUPABASE_ANON_KEY: "env-module-anon-key",
  }),
}));

import { createServerClient } from "@supabase/ssr";

import {
  createResolvingSessionClient,
  removeSessionCookies,
} from "@/lib/database/session-client";

type SetAll = (
  cookies: { name: string; value: string; options: object }[],
  headers: Record<string, string>,
) => void;

afterEach(() => {
  vi.clearAllMocks();
  cookieStore.getAll.mockReturnValue([]);
});

async function resolvingClient() {
  const client = await createResolvingSessionClient();
  const options = vi.mocked(createServerClient).mock.calls[0]?.[2];
  if (!options) {
    throw new Error("createServerClient was not called");
  }
  const { setAll } = options.cookies as { setAll: SetAll };
  return { ...client, setAll };
}

const NAME = "sb-env-module-auth-token";

describe("createResolvingSessionClient", () => {
  it("holds a batch that only removes the session", async () => {
    const { setAll } = await resolvingClient();

    setAll(
      [
        { name: NAME, value: "", options: { maxAge: 0 } },
        { name: `${NAME}.0`, value: "", options: { maxAge: 0 } },
      ],
      {},
    );

    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("writes the held removals once told the session really was refused", async () => {
    const { setAll, applyHeldRemovals } = await resolvingClient();
    setAll([{ name: NAME, value: "", options: { maxAge: 0 } }], {});

    applyHeldRemovals();

    expect(cookieStore.set).toHaveBeenCalledWith(
      NAME,
      "",
      expect.objectContaining({ maxAge: 0, httpOnly: true }),
    );
  });

  it("writes a new session and its stale-chunk removals at once, never holding the removals", async () => {
    // Holding the removals here would leave stale chunks next to the new
    // session, and @supabase/ssr would read them together on the next request.
    const { setAll } = await resolvingClient();

    setAll(
      [
        { name: NAME, value: "base64-refreshed", options: { maxAge: 3600 } },
        { name: `${NAME}.0`, value: "", options: { maxAge: 0 } },
        { name: `${NAME}.1`, value: "", options: { maxAge: 0 } },
      ],
      {},
    );

    expect(
      cookieStore.set.mock.calls.map(([name, value]) => [name, value]),
    ).toEqual([
      [NAME, "base64-refreshed"],
      [`${NAME}.0`, ""],
      [`${NAME}.1`, ""],
    ]);
  });

  it("treats an expiry in the past as a removal", async () => {
    const { setAll } = await resolvingClient();

    setAll(
      [{ name: NAME, value: "gone", options: { expires: new Date(0) } }],
      {},
    );

    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});

describe("removeSessionCookies", () => {
  it("expires the session and a generous range of chunks by name, seen or not", () => {
    removeSessionCookies(cookieStore as never, NAME);

    const expired = cookieStore.set.mock.calls.map(([name]) => name as string);
    expect(expired).toContain(NAME);
    for (let index = 0; index < 20; index += 1) {
      expect(expired).toContain(`${NAME}.${index}`);
    }
  });

  it("also expires visible chunks beyond that range", () => {
    cookieStore.getAll.mockReturnValue([{ name: `${NAME}.25`, value: "x" }]);

    removeSessionCookies(cookieStore as never, NAME);

    expect(cookieStore.set.mock.calls.map(([name]) => name)).toContain(
      `${NAME}.25`,
    );
  });

  it("leaves cookies that only share the prefix alone", () => {
    cookieStore.getAll.mockReturnValue([
      { name: `${NAME}-code-verifier`, value: "v" },
      { name: "a50_sign_in_flow", value: "t" },
    ]);

    removeSessionCookies(cookieStore as never, NAME);

    const expired = cookieStore.set.mock.calls.map(([name]) => name);
    expect(expired).not.toContain(`${NAME}-code-verifier`);
    expect(expired).not.toContain("a50_sign_in_flow");
  });
});

import { expect, test } from "@playwright/test";

/**
 * The public disclosure endpoint against a production build (TASK-019a).
 *
 * The unit and integration suites call the route handler directly, which
 * proves what the handler returns but not what Next.js finally sends: a
 * route handler that sets no `Cache-Control` is served `no-store`, and the
 * proxy stamps its own headers on everything it matches. Both of those
 * happen in the framework, not in the handler, so the two claims this
 * endpoint rests on — that it is publicly cacheable, and that the proxy
 * does not run on it — can only be checked here.
 *
 * No browser session and no seeded data: a well-formed identifier that
 * names nothing and a malformed one carry exactly the same headers as a
 * hit, so they prove the same thing without a fixture.
 */

const PUBLIC_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

const UNKNOWN = "/api/public/disclosure/dep_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const MALFORMED = "/api/public/disclosure/DEP_AAAAAAAAAAAAAAAAAAAAAAAAAA";

test.describe("the public endpoint, as the network sees it", () => {
  test("keeps its public cache and CORS headers through the framework", async ({
    request,
  }) => {
    const response = await request.get(UNKNOWN);

    expect(response.status()).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "disclosure_not_found" },
    });
    // Next.js sends `private, no-cache, no-store` for a dynamic route that
    // sets no policy of its own. This is the assertion that the route's
    // policy is the one that ships.
    expect(response.headers()["cache-control"]).toBe(PUBLIC_CACHE_CONTROL);
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["set-cookie"]).toBeUndefined();

    // Next.js adds a `Vary` of its own for router requests; the route sets
    // none. What matters for a shared cache is what it does *not* name: a
    // `Vary: Cookie` would let a cached answer depend on a visitor, and a
    // `Vary: Origin` would split this cache per site for no gain.
    const vary = response.headers()["vary"]?.toLowerCase() ?? "";
    expect(vary).not.toContain("cookie");
    expect(vary).not.toContain("origin");
  });

  test("is not touched by the proxy", async ({ request }) => {
    const response = await request.get(UNKNOWN);

    // The CSP is the proxy's alone — it is built per request around a nonce.
    // Its absence is the evidence that the matcher exclusion holds. If this
    // starts failing, the proxy is building a session client per request on
    // the one surface that has no session, and reading cookies whose value
    // a shared cache must never depend on.
    expect(response.headers()["content-security-policy"]).toBeUndefined();

    // The headers that never vary per request come from next.config.ts and
    // apply to every path, this one included: excluding the proxy costs
    // none of them.
    expect(response.headers()["referrer-policy"]).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers()["permissions-policy"]).toContain("camera=()");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("refuses a wrong-cased identifier legibly", async ({ request }) => {
    const response = await request.get(MALFORMED);

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_deployment_id" },
    });
    expect(response.headers()["cache-control"]).toBe(PUBLIC_CACHE_CONTROL);
  });

  test("still stamps the dashboard's headers on a neighbouring path", async ({
    request,
  }) => {
    // The exclusion is anchored: a path that merely starts like it keeps
    // everything the proxy gives. Without this, `/api/public/` could widen
    // to `/api/publications` unnoticed.
    const response = await request.get("/api/publications", {
      failOnStatusCode: false,
    });

    expect(response.headers()["content-security-policy"]).toContain(
      "default-src 'self'",
    );
  });
});

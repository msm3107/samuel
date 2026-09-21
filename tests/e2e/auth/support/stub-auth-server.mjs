// A stand-in for the Supabase auth endpoints the application calls, so the
// end-to-end specs can drive a real sign-in without a Supabase instance. It
// implements only what auth-js needs, and cannot tell a registered address from
// an unregistered one — so it proves the screen's behaviour, not GoTrue's.
// TASK-003b points these specs at real local Supabase.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

import { E2E_RATE_LIMIT_HMAC_SECRET } from "./e2e-env.mjs";

const PORT = Number(process.argv[2] ?? 54400);

/**
 * Shaped like GoTrue's access token: a JWT whose `amr` claim gives the sign-in
 * time the application reads for the session's age (TASK-003h). Unsigned; the
 * stub accepts it by exact match.
 */
function stubAccessToken() {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signedInAt = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      sub: "e2e-user",
      amr: [{ method: "otp", timestamp: signedInAt }],
    }),
    encode({ stub: "e2e" }),
  ].join(".");
}

export const E2E_USER = {
  id: "0b6a2a4e-6f3c-4c1e-9d2a-2f6a1c9e8b11",
  email: "e2e-user@example.test",
  accessToken: stubAccessToken(),
  refreshToken: "e2e-refresh-token",
};

/**
 * The auth code the OTP request "emails"; specs hand it back to
 * /auth/callback. Kept in step with AUTH_CODE in sign-in.spec.ts.
 */
export const E2E_AUTH_CODE = "3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33";

const user = {
  id: E2E_USER.id,
  aud: "authenticated",
  role: "authenticated",
  email: E2E_USER.email,
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};

/**
 * A code is single-use per sign-in flow, keyed by the verifier that flow
 * created. A replay in the same browser fails as GoTrue's would, while a retry
 * or a parallel test — each with its own fresh verifier — can still sign in.
 */
const usedFlows = new Set();

/**
 * The application's rate-limit database call (TASK-003c). Every hit is
 * allowed, except that the global magic-link bucket can be reported full, so
 * the challenge spec can drive the form past the threshold. The key is the
 * application's own HMAC of "magic_link:global:global"
 * (lib/security/rate-limit.ts).
 */
const GLOBAL_MAGIC_LINK_KEY = createHmac("sha256", E2E_RATE_LIMIT_HMAC_SECRET)
  .update("magic_link:global:global")
  .digest("hex");
let overGlobalThreshold = false;

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "x-supabase-api-version": "2024-01-01",
  });
  response.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/__health") {
    response.writeHead(200, { "content-type": "text/plain" });
    return response.end("e2e-stub-auth-server");
  }

  // Test-only control, never part of Supabase's API: set by the challenge
  // spec, which runs after every other spec (playwright.config.ts).
  if (request.method === "POST" && url.pathname === "/__control/threshold") {
    const body = await readBody(request);
    overGlobalThreshold = body.over === true;
    return send(response, 200, { over: overGlobalThreshold });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/rest/v1/rpc/consume_rate_limit"
  ) {
    const body = await readBody(request);
    return send(
      response,
      200,
      !(overGlobalThreshold && body.p_key === GLOBAL_MAGIC_LINK_KEY),
    );
  }

  if (request.method === "GET" && url.pathname === "/auth/v1/user") {
    const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    return token === E2E_USER.accessToken
      ? send(response, 200, user)
      : send(response, 403, { code: "bad_jwt", msg: "invalid JWT" });
  }

  if (request.method === "POST" && url.pathname === "/auth/v1/otp") {
    return send(response, 200, {});
  }

  if (url.pathname === "/auth/v1/token") {
    const body = await readBody(request);
    if (url.searchParams.get("grant_type") === "pkce") {
      const flow = `${body.auth_code}:${body.code_verifier}`;
      if (body.auth_code !== E2E_AUTH_CODE || usedFlows.has(flow)) {
        return send(response, 404, {
          code: "flow_state_not_found",
          msg: "not found",
        });
      }
      usedFlows.add(flow);
      return send(response, 200, {
        access_token: E2E_USER.accessToken,
        refresh_token: E2E_USER.refreshToken,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      });
    }
    return send(response, 400, {
      code: "refresh_token_not_found",
      msg: "no",
    });
  }

  if (request.method === "POST" && url.pathname === "/auth/v1/logout") {
    response.writeHead(204);
    return response.end();
  }

  send(response, 404, { code: "not_found", msg: "no stub for this route" });
}).listen(PORT, "127.0.0.1");

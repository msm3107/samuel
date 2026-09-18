// Starts a production Next.js server for Playwright, bound to localhost only.
// Run the e2e build first; the test:e2e scripts do.
//
//   node start-e2e-app.mjs <port>             against the stub auth server
//   node start-e2e-app.mjs <port> --supabase  against the running local Supabase
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { localAppEnv } from "../../../../scripts/local-env.mjs";
import { E2E_APP_PORT, e2eEnv } from "./e2e-env.mjs";

const APP_PORT = Number(process.argv[2] ?? E2E_APP_PORT);
const AUTH_PORT = APP_PORT + 1;
const AGAINST_SUPABASE = process.argv.includes("--supabase");

let stub;
let next;

function shutdown(code) {
  stub?.kill();
  next?.kill();
  process.exit(code);
}

async function startStub() {
  stub = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./stub-auth-server.mjs", import.meta.url)),
      String(AUTH_PORT),
    ],
    { stdio: "inherit" },
  );

  // If the stub cannot bind, tests must not run against whatever else owns
  // the port — some would pass against a foreign server and prove nothing.
  stub.on("exit", (code) => shutdown(code === 0 ? 1 : (code ?? 1)));
  stub.on("error", () => shutdown(1));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${AUTH_PORT}/__health`);
      if (response.ok && (await response.text()) === "e2e-stub-auth-server") {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  shutdown(1);
}

function appEnv() {
  if (!AGAINST_SUPABASE) {
    return e2eEnv(APP_PORT);
  }
  // Real local Supabase: its URL and keys, with every other variable still
  // the e2e placeholder. localAppEnv throws if Supabase is not running.
  const { LOCAL_MAILPIT_URL: _mailpit, ...supabase } = localAppEnv({
    appUrl: `http://localhost:${APP_PORT}`,
  });
  return { ...e2eEnv(APP_PORT), ...supabase };
}

if (!AGAINST_SUPABASE) {
  await startStub();
}

const nextBin = fileURLToPath(
  new URL("../../../../node_modules/next/dist/bin/next", import.meta.url),
);

// Bound to localhost so the app is not reachable from the network during a
// run. Next is started by node directly: spawning pnpm.cmd fails on Windows.
next = spawn(
  process.execPath,
  [nextBin, "start", "-H", "localhost", "-p", String(APP_PORT)],
  { stdio: "inherit", env: appEnv() },
);

next.on("exit", (code) => shutdown(code ?? 0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

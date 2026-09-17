// Builds the application with the same placeholder environment the e2e server
// runs with. `pnpm build` alone fails in a clean shell, because collecting page
// data validates the server configuration.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { E2E_APP_PORT, e2eEnv } from "./e2e-env.mjs";

const nextBin = fileURLToPath(
  new URL("../../../../node_modules/next/dist/bin/next", import.meta.url),
);

const { status } = spawnSync(process.execPath, [nextBin, "build"], {
  stdio: "inherit",
  env: e2eEnv(E2E_APP_PORT),
});

process.exit(status ?? 1);

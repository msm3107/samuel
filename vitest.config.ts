import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // End-to-end specs run under Playwright, not Vitest.
    exclude: ["tests/e2e/**", "node_modules/**"],
    setupFiles: ["tests/setup-test-env.ts"],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname,
    },
  },
});

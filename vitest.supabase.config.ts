import { defineConfig } from "vitest/config";

/**
 * Suites that run against a real local Supabase instance. Kept apart from the
 * default config, which includes only `*.test.ts`, so `pnpm test` and CI's
 * existing jobs never need Supabase. Run with `pnpm test:supabase`, which
 * reads the local instance's URLs and keys first.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/supabase/**/*.supabase.ts"],
    setupFiles: ["tests/supabase/support/require-local-supabase.ts"],
    restoreMocks: true,
    // Real network, real mail delivery: slower than the stubbed suites.
    testTimeout: 30_000,
    // One Supabase instance and one mailbox are shared, so files run in turn.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname,
    },
  },
});

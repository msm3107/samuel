import js from "@eslint/js";
import next from "eslint-config-next";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
      "public/widget/**/*.min.js",
    ],
  },
  js.configs.recommended,
  {
    // TASK-020: the public widget ships unbuilt and runs in somebody else's
    // page, so it is a plain browser script rather than part of the
    // application's module graph. Linted like everything else; its types
    // are checked by tsconfig.widget.json.
    files: ["public/widget.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "script",
      globals: {
        CSSStyleSheet: "readonly",
        Document: "readonly",
        HTMLScriptElement: "readonly",
        URL: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
      },
    },
  },
  ...next,
  ...nextCoreWebVitals,
  ...nextTypescript,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Rule 26: escape hatches around the type system need justification, so
      // they surface as errors rather than silent style noise.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    // TASK-023 (PR #40 review, note 3): a `*.internal.ts` module exists to
    // hold the test seams its public sibling deliberately does not expose.
    // `features/verification/fetch-page.internal.ts` takes a `lookup`, which
    // replaces the guarded one and so removes the SSRF guarantee outright —
    // so application code may not reach it, and the restriction fires at
    // review time rather than at runtime (the `public/widget.js` block above
    // is the precedent). A new internal module adds its public sibling to the
    // ignore list below.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["tests/**", "features/verification/fetch-page.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/*.internal", "**/*.internal.ts"],
              message:
                "Import the public module beside it. An *.internal module holds test seams that application code must not pass.",
            },
          ],
        },
      ],
    },
  },
  {
    // Rule 16: only the environment module reads process.env, so a stray
    // read anywhere else is a review signal rather than a convention.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "lib/env/**",
      "instrumentation.ts",
      "next.config.ts",
      "vitest.config.ts",
      "tests/setup-test-env.ts",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration through lib/env instead of process.env directly.",
        },
      ],
    },
  },
);

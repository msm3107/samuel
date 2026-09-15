import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { DASHBOARD_ROUTE_DIRECTORY } from "@/lib/auth/protected-routes";

const REPOSITORY_ROOT = join(__dirname, "..", "..", "..");
const DASHBOARD_GROUP = join(REPOSITORY_ROOT, "app", "(dashboard)");

/** Every file convention that makes a URL servable in the App Router. */
const ROUTE_FILE = /^(page|route|default)\.(js|jsx|ts|tsx|mdx)$/;

/**
 * Intercepting routes (`(.)x`, `(..)x`, `(...)x`) render for a URL other than
 * their directory's, during client navigation — exactly when the layout check
 * does not re-run.
 */
const INTERCEPTING_SEGMENT = /^\(\.{1,3}\)/;

function entriesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? [path, ...entriesUnder(path)] : [path];
  });
}

function toRepositoryPath(path: string) {
  return relative(REPOSITORY_ROOT, path).split(sep).join("/");
}

function lastSegment(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

describe("dashboard route placement", () => {
  // The proxy guards the /dashboard URL prefix; the layout guards the
  // (dashboard) route group. Route groups add no URL segment, so a page placed
  // at app/(dashboard)/settings would be served at /settings with only the
  // layout — which Next.js can skip — protecting it.
  const entries = entriesUnder(DASHBOARD_GROUP).map(toRepositoryPath);

  it("keeps every route in the dashboard group under the /dashboard URL prefix", () => {
    const misplaced = entries
      .filter((path) => ROUTE_FILE.test(lastSegment(path)))
      .filter((path) => !path.startsWith(`${DASHBOARD_ROUTE_DIRECTORY}/`));

    expect(misplaced).toEqual([]);
  });

  it("contains no intercepting route, which could render for a URL the proxy does not guard", () => {
    const intercepting = entries.filter((path) =>
      path.split("/").some((segment) => INTERCEPTING_SEGMENT.test(segment)),
    );

    expect(intercepting).toEqual([]);
  });

  it("recognises the file conventions it guards against", () => {
    expect(
      ["page.tsx", "page.jsx", "page.mdx", "route.ts", "default.js"].every(
        (name) => ROUTE_FILE.test(name),
      ),
    ).toBe(true);
    expect(
      ["(.)settings", "(..)settings", "(...)settings"].every((segment) =>
        INTERCEPTING_SEGMENT.test(segment),
      ),
    ).toBe(true);
    expect(INTERCEPTING_SEGMENT.test("(dashboard)")).toBe(false);
  });
});

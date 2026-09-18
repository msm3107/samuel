import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/globals.css", () => ({}));

import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";

/**
 * Error pages are what a visitor sees when something unexpected fails. They
 * must give a reference, and must never show the error's own text, which can
 * carry SQL, hostnames or paths (`README.md` §25). Codex review of PR #6,
 * finding F9.
 */
const INTERNAL_DETAIL =
  'relation "rate_limits" does not exist at db.internal.example:5432';

function failure(digest?: string) {
  const error: Error & { digest?: string } = new Error(INTERNAL_DETAIL);
  if (digest !== undefined) {
    error.digest = digest;
  }
  return error;
}

describe.each([
  ["the route error page", ErrorPage],
  ["the global error page", GlobalError],
])("%s", (_name, Page) => {
  it("shows the digest as a reference", () => {
    const html = renderToStaticMarkup(
      createElement(Page, { error: failure("1234567890"), reset: () => {} }),
    );

    expect(html).toContain("Reference:");
    expect(html).toContain("1234567890");
  });

  it("never shows the error's own message", () => {
    const html = renderToStaticMarkup(
      createElement(Page, { error: failure("1234567890"), reset: () => {} }),
    );

    expect(html).not.toContain("rate_limits");
    expect(html).not.toContain("db.internal.example");
  });

  it("renders without a reference when there is no digest, still hiding the message", () => {
    const html = renderToStaticMarkup(
      createElement(Page, { error: failure(), reset: () => {} }),
    );

    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("Reference:");
    expect(html).not.toContain("rate_limits");
  });
});

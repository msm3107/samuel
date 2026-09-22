import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What a dashboard page or server action did, for tests that call them
 * directly (TASK-010). `notFound()` and `redirect()` throw errors whose
 * digest names them; this reads the digest rather than mocking
 * `next/navigation`, so the real functions run.
 */
export type Outcome =
  | { kind: "rendered"; html: string }
  | { kind: "returned"; value: unknown }
  | { kind: "not_found" }
  | { kind: "redirect"; location: string };

function interrupt(error: unknown): Outcome | null {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String(error.digest)
      : "";
  if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
    return { kind: "not_found" };
  }
  if (digest.startsWith("NEXT_REDIRECT;")) {
    return { kind: "redirect", location: digest.split(";")[2] ?? "" };
  }
  return null;
}

/** Renders a server component page to HTML, or reports its interrupt. */
export async function renderPage(
  page: () => Promise<ReactElement>,
): Promise<Outcome> {
  try {
    return { kind: "rendered", html: renderToStaticMarkup(await page()) };
  } catch (error) {
    const outcome = interrupt(error);
    if (outcome === null) {
      throw error;
    }
    return outcome;
  }
}

/** Runs a server action, and reports what it returned or its interrupt. */
export async function runAction(
  action: () => Promise<unknown>,
): Promise<Outcome> {
  try {
    return { kind: "returned", value: await action() };
  } catch (error) {
    const outcome = interrupt(error);
    if (outcome === null) {
      throw error;
    }
    return outcome;
  }
}

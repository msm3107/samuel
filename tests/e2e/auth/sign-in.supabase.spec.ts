import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { waitForMagicLink } from "../../supabase/support/mailpit";

/**
 * Sign-in in a real browser against the real local Supabase: the screen asks
 * GoTrue for a link, GoTrue mails it to Mailpit, and the browser opens it as a
 * person would. Nothing is stubbed. Run with `pnpm test:e2e:supabase`.
 */

function freshAddress() {
  return `e2e-${randomUUID()}@example.test`;
}

async function requestLink(page: import("@playwright/test").Page) {
  const address = freshAddress();
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  return address;
}

test("signs in by magic link from real email and lands on the dashboard", async ({
  page,
  context,
}) => {
  const address = await requestLink(page);
  const link = await waitForMagicLink(address);

  await page.goto(link);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // The session is out of reach of page scripts.
  const session = (await context.cookies()).filter((cookie) =>
    cookie.name.startsWith("sb-"),
  );
  expect(session.length).toBeGreaterThan(0);
  expect(session.every((cookie) => cookie.httpOnly)).toBe(true);
});

test("refuses a link opened in a browser that did not request it", async ({
  page,
  browser,
}) => {
  const address = await requestLink(page);
  const link = await waitForMagicLink(address);

  // Another device: a fresh browser context with none of this one's cookies.
  const otherDevice = await browser.newContext();
  const otherPage = await otherDevice.newPage();
  await otherPage.goto(link);

  await expect(otherPage).toHaveURL(/\/sign-in\?error=link_other_browser$/);
  await expect(otherPage.getByRole("main").getByRole("alert")).toContainText(
    "same browser",
  );
  await otherDevice.close();
});

// Server-side revocation is covered by tests/supabase/auth/sign-in.supabase.ts;
// this checks the browser side of losing the session.
test("closes the dashboard once the session cookies are gone", async ({
  page,
  context,
}) => {
  const address = await requestLink(page);
  await page.goto(await waitForMagicLink(address));
  await expect(page).toHaveURL(/\/dashboard$/);

  // Drop the session cookies, as signing out does.
  await context.clearCookies();
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/sign-in$/);
});

// The dashboard's organization form moved to
// tests/e2e/dashboard/ai-systems.supabase.spec.ts, to share a sign-in.

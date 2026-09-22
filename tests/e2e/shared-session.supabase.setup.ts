import { randomUUID } from "node:crypto";

import { expect, test as setup } from "@playwright/test";

import { waitForMagicLink } from "../supabase/support/mailpit";
import { SHARED_SESSION_FILE } from "./support/shared-session";

/**
 * Signs in once for the whole run and saves the session (TASK-015a). Magic
 * links are limited per network every ten minutes (TASK-003c), so every
 * spec signing in for itself would make the suite fail as it grows. The
 * limit itself is a reviewed security setting and stays as it is.
 *
 * A fresh address every run: a brand-new user with no organization.
 */
setup("signs in once for the specs that share a session", async ({ page }) => {
  const address = `e2e-shared-${randomUUID()}@example.test`;
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.goto(await waitForMagicLink(address));
  await expect(page).toHaveURL(/\/dashboard$/);

  // The one check that needs a user with nothing yet (TASK-007's empty
  // dashboard), made here, before any spec creates an organization.
  await expect(
    page.getByText("You are not in any organization yet"),
  ).toBeVisible();

  await page.context().storageState({ path: SHARED_SESSION_FILE });
});

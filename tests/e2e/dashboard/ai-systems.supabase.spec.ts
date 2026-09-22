import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { waitForMagicLink } from "../../supabase/support/mailpit";

/**
 * The dashboard in a real browser against the real local Supabase: an
 * organization created from the dashboard (TASK-007), then its AI systems
 * registered, archived and found again by keyboard alone (TASK-010, the
 * plan's exit criterion for Phase 3). Run with `pnpm test:e2e:supabase`.
 *
 * One sign-in serves all three tests. Magic links are limited to five per network
 * every ten minutes (TASK-003c), the suite already asks for three more, and
 * CI retries a failed test, so every sign-in spent here is one less retry. The third test opens a second tab in the same session, so
 * it needs none.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let organizationName: string;
let systemUrl: string;

test.beforeAll(async ({ browser }) => {
  // A context, not browser.newPage(), so a test can open a second tab in
  // the same session.
  context = await browser.newContext();
  page = await context.newPage();
  const address = `e2e-${randomUUID()}@example.test`;
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(address);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.goto(await waitForMagicLink(address));
  await expect(page).toHaveURL(/\/dashboard$/);
});

test.afterAll(async () => {
  await context.close();
});

// Moved from sign-in.supabase.spec.ts, to share the sign-in above.
test("creates an organization from the dashboard and lists it", async () => {
  await expect(
    page.getByText("You are not in any organization yet"),
  ).toBeVisible();

  organizationName = `E2E Org ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Organization name").fill(`  ${organizationName}  `);
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  const list = page.getByRole("main").getByRole("list");
  await expect(list.getByText(organizationName, { exact: true })).toBeVisible();
  await expect(list).toContainText(
    organizationName.toLowerCase().replaceAll(" ", "-"),
  );
});

/** Whether the focused element shows an outline a sighted user can see. */
async function focusRingOf(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      focused: node === document.activeElement,
      outlined:
        style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
    };
  });
}

/**
 * Presses Tab until `target` has focus, checking at every stop on the way
 * that the focused element shows an outline. Fails if `target` is not
 * reached: something on the way would be a keyboard trap, or `target` is
 * not focusable.
 */
async function tabTo(target: Locator, maxStops = 40, key = "Tab") {
  for (let stop = 0; stop < maxStops; stop += 1) {
    await page.keyboard.press(key);
    const focused = page.locator(":focus");
    expect(await focusRingOf(focused)).toEqual({
      focused: true,
      outlined: true,
    });
    if (await target.evaluate((node) => node === document.activeElement)) {
      return;
    }
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

/**
 * Starts the next Tab from the top of the page, as a fresh visit does. A
 * reload, because blurring leaves Chrome's starting point for sequential
 * focus where the last focus was.
 */
async function fromTheTop() {
  await page.reload();
}

test("registers, archives and finds an AI system by keyboard alone", async () => {
  const main = page.getByRole("main");
  const systemName = `Keyboard bot ${randomUUID().slice(0, 8)}`;

  // The dashboard: the skip link is the first stop, and visible when focused.
  await fromTheTop();
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await tabTo(skipLink, 1);
  await expect(skipLink).toBeVisible();

  await tabTo(main.getByRole("link", { name: organizationName }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard\/[0-9a-f-]{36}\/systems$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "AI systems" }),
  ).toBeVisible();
  await expect(main).toContainText("No active AI systems.");

  // The list: every control is reached, in order, each with a visible outline.
  await fromTheTop();
  await tabTo(page.getByRole("link", { name: "Dashboard", exact: true }));
  await tabTo(main.getByRole("link", { name: "Register an AI system" }), 1);
  await tabTo(main.getByRole("link", { name: "Active", exact: true }), 1);
  await expect(
    main.getByRole("link", { name: "Active", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await tabTo(main.getByRole("link", { name: "Archived", exact: true }), 1);
  await tabTo(main.getByRole("link", { name: "All", exact: true }), 1);

  // Registration.
  await fromTheTop();
  await tabTo(main.getByRole("link", { name: "Register an AI system" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/systems\/new$/);

  await tabTo(page.getByLabel("Name", { exact: true }));
  await page.keyboard.type(systemName);
  await tabTo(page.getByLabel("Type", { exact: true }), 1);
  await page.keyboard.type("Voice");
  await expect(page.getByLabel("Type", { exact: true })).toHaveValue(
    "voice_agent",
  );
  await tabTo(page.getByLabel("Provider (optional)"), 1);
  await page.keyboard.type("Acme");
  await tabTo(page.getByLabel("Description (optional)"), 1);
  await page.keyboard.type("Answers the phone.");
  await tabTo(page.getByRole("button", { name: "Register", exact: true }), 1);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/systems\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { level: 1, name: systemName }),
  ).toBeVisible();
  await expect(main).toContainText("Voice agent");

  // Archive, and hear about it.
  await tabTo(main.getByRole("button", { name: "Archive this system" }));
  await page.keyboard.press("Enter");
  await expect(
    main.getByRole("status").filter({ hasText: "Archived." }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "Restore this system" }),
  ).toBeVisible();

  // Edit after archiving. The archive stored a newer version; the untouched
  // edit form took it on, so this save isn't refused as stale.
  systemUrl = page.url();
  // Backwards, without a reload, as the form sits above the archive button.
  await tabTo(page.getByLabel("Description (optional)"), 10, "Shift+Tab");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Answers the phone, in English.");
  await tabTo(page.getByRole("button", { name: "Save changes" }), 1);
  await page.keyboard.press("Enter");
  await expect(
    main.getByRole("status").filter({ hasText: "Changes saved." }),
  ).toBeVisible();

  // Back to the list: gone from the active systems, found under Archived.
  await fromTheTop();
  await tabTo(page.getByRole("link", { name: "AI systems", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/systems$/);
  await expect(main).not.toContainText(systemName);

  await tabTo(main.getByRole("link", { name: "Archived", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/systems\?status=archived$/);
  await expect(main.getByRole("link", { name: systemName })).toBeVisible();
});

// TASK-010 review, finding 1. A second tab shares the session, so this
// needs no sign-in of its own.
test("a save from another tab makes this tab's edit stale, and nothing is overwritten", async () => {
  const other = await context.newPage();
  await Promise.all([page.goto(systemUrl), other.goto(systemUrl)]);

  // The other tab saves first.
  await other.getByLabel("Provider (optional)").fill("Other tab's vendor");
  await other.getByRole("button", { name: "Save changes" }).click();
  await expect(
    other.getByRole("status").filter({ hasText: "Changes saved." }),
  ).toBeVisible();

  // This tab still holds the version it loaded.
  await page.getByLabel("Name", { exact: true }).fill("Renamed in this tab");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Someone changed this system" }),
  ).toBeVisible();
  // What was typed stays; the other tab's change stands.
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Renamed in this tab",
  );
  await other.reload();
  await expect(other.getByLabel("Provider (optional)")).toHaveValue(
    "Other tab's vendor",
  );
  await expect(other.getByLabel("Name", { exact: true })).not.toHaveValue(
    "Renamed in this tab",
  );
  await other.close();
});

// TASK-015. Shares the session above rather than signing in again (magic
// links are rate-limited). systemUrl's system was archived by the first
// test and never restored, so this restores it first; that step is setup,
// not the flow under test, so it isn't done by keyboard.
test("registers, archives and restores a deployment by keyboard alone", async () => {
  const main = page.getByRole("main");

  await page.goto(systemUrl);
  const restoreSystem = main.getByRole("button", {
    name: "Restore this system",
  });
  if (await restoreSystem.isVisible()) {
    await restoreSystem.click();
    await expect(
      main.getByRole("status").filter({ hasText: "Restored." }),
    ).toBeVisible();
  }

  // A refused hostname first, with its own message and nothing registered.
  await fromTheTop();
  await tabTo(page.getByLabel("Hostname", { exact: true }));
  await page.keyboard.type("localhost");
  await tabTo(main.getByRole("button", { name: "Register hostname" }), 1);
  await page.keyboard.press("Enter");
  // The system page has three forms, each with its own live region.
  const registration = main
    .getByRole("region", { name: "Deployments" })
    .getByRole("status");
  await expect(registration).toContainText("Problem:");
  await expect(registration).toContainText(
    "can't be checked from the internet",
  );
  await expect(page.getByLabel("Hostname", { exact: true })).toHaveValue(
    "localhost",
  );

  // A valid, unique hostname.
  const host = `e2e-${randomUUID().slice(0, 8)}.example.com`;
  await fromTheTop();
  await tabTo(page.getByLabel("Hostname", { exact: true }));
  await page.keyboard.type(host);
  await tabTo(main.getByRole("button", { name: "Register hostname" }), 1);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]{36}$/);
  const publicId = main.locator("code");
  await expect(publicId).toHaveText(/^dep_[a-z2-7]{26}$/);
  const registeredId = await publicId.textContent();

  // Archive, and hear about it.
  await fromTheTop();
  await tabTo(main.getByRole("button", { name: "Archive this deployment" }));
  await page.keyboard.press("Enter");
  await expect(
    main.getByRole("status").filter({ hasText: "Archived." }),
  ).toBeVisible();

  // Restore: the same public ID comes back.
  await fromTheTop();
  await tabTo(main.getByRole("button", { name: "Restore this deployment" }));
  await page.keyboard.press("Enter");
  await expect(
    main.getByRole("status").filter({ hasText: "Restored." }),
  ).toBeVisible();
  await expect(publicId).toHaveText(registeredId ?? "");
});

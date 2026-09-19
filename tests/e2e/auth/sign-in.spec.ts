import { expect, test } from "@playwright/test";

/**
 * Drives the sign-in screen in a real browser against a production build. The
 * auth server is the stub in `tests/e2e/auth/support/`, so these prove the screen,
 * the server actions, the callback and the proxy work together — not that a
 * real Supabase instance does. That arrives with TASK-003b.
 */

/** Kept in step with E2E_AUTH_CODE in support/stub-auth-server.mjs. */
const AUTH_CODE = "3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33";

/**
 * Next.js renders its own empty `role="alert"` route announcer, so the page's
 * own alert is addressed inside the main landmark.
 */
function pageAlert(page: import("@playwright/test").Page) {
  return page.getByRole("main").getByRole("alert");
}

test("shows the confirmation state after requesting a magic link", async ({
  page,
}) => {
  await page.goto("/sign-in");

  await page.getByLabel("Email address").fill("person@example.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();

  await expect(page.getByRole("status")).toContainText("Check your email");
});

test("is reachable and submittable by keyboard alone", async ({ page }) => {
  await page.goto("/sign-in");

  // Tab until the email field has focus, typing nothing by mouse.
  const email = page.getByLabel("Email address");
  for (let presses = 0; presses < 10; presses += 1) {
    if (await email.evaluate((node) => node === document.activeElement)) {
      break;
    }
    await page.keyboard.press("Tab");
  }
  await expect(email).toBeFocused();

  await page.keyboard.type("keyboard@example.test");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Email me a sign-in link" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toContainText("Check your email");
});

// The stub cannot tell addresses apart, so this proves only that the screen
// has one answer for both. Whether real Supabase answers identically — codes
// and timing — is for the TASK-003b suite against a real instance.
test("gives an unknown address the same answer as a known one", async ({
  page,
}) => {
  const answers: string[] = [];

  for (const address of ["known@example.test", "nobody@example.test"]) {
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(address);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("status")).toContainText("Check your email");
    answers.push((await page.getByRole("status").textContent()) ?? "");
  }

  expect(answers[0]).toBe(answers[1]);
});

test("signs in through the callback and reaches the dashboard", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("person@example.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");

  // The link the email would carry, opened in the same browser.
  await page.goto(`/auth/callback?code=${AUTH_CODE}`);

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
});

test("sends a signed-out visitor from the dashboard to sign-in", async ({
  page,
}) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("explains a link opened in another browser without echoing the query", async ({
  page,
}) => {
  // No verifier cookie in this context: the same failure a link opened on
  // another device produces.
  await page.goto(`/auth/callback?code=${AUTH_CODE}`);

  await expect(page).toHaveURL(/\/sign-in\?error=link_other_browser$/);
  await expect(pageAlert(page)).toContainText("same browser");
});

test("shows the generic message for an unrecognised error code", async ({
  page,
}) => {
  await page.goto("/sign-in?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E");

  await expect(pageAlert(page)).toContainText("Sign-in did not complete");
  await expect(pageAlert(page)).not.toContainText("script");
});

test("keeps every script tag under the response nonce", async ({ page }) => {
  const response = await page.goto("/sign-in");
  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];

  expect(nonce).toBeTruthy();
  // Browsers blank the nonce attribute and keep the value on the property, so
  // the DOM property is what proves the policy matches the rendered tags.
  const nonces = await page
    .locator("script")
    .evaluateAll((scripts) =>
      scripts.map((script) => (script as HTMLScriptElement).nonce),
    );

  expect(nonces.length).toBeGreaterThan(0);
  expect(nonces.every((value) => value === nonce)).toBe(true);
});

test("keeps keyboard focus and announces progress while a link is being sent, sending only one request", async ({
  page,
}) => {
  let actionPosts = 0;
  // Hold the server action open long enough to act during the pending state.
  await page.route("**/sign-in", async (route) => {
    if (route.request().method() !== "POST") {
      return route.continue();
    }
    actionPosts += 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return route.continue();
  });

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("person@example.test");

  const button = page.getByRole("button", { name: /sign-in link/ });
  await button.focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("status")).toContainText("Sending sign-in link");
  // Pressing again while the request is in flight must not send another.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-disabled", "true");

  await expect(page.getByRole("status")).toContainText("Check your email");
  await expect(button).toBeFocused();
  expect(actionPosts).toBe(1);
});

test("keeps the typed address after a request", async ({ page }) => {
  await page.goto("/sign-in");
  const email = page.getByLabel("Email address");

  await email.fill("not-an-address");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();

  await expect(page.getByRole("status")).toContainText("Problem:");
  await expect(email).toHaveValue("not-an-address");
  await expect(email).toHaveAttribute("aria-invalid", "true");
});

test("shows the generic message for a repeated error parameter", async ({
  page,
}) => {
  await page.goto("/sign-in?error=link_expired&error=link_invalid");

  await expect(pageAlert(page)).toContainText("Sign-in did not complete");
});

test("clears a callback error once a new link is requested", async ({
  page,
}) => {
  await page.goto("/sign-in?error=link_expired");
  await expect(pageAlert(page)).toContainText("expired");

  await page.getByLabel("Email address").fill("person@example.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();

  await expect(page.getByRole("status")).toContainText("Check your email");
  await expect(pageAlert(page)).toHaveCount(0);
});

test("names the page for assistive technology and browser tabs", async ({
  page,
}) => {
  await page.goto("/sign-in");

  await expect(page).toHaveTitle("Sign in · Article50.js");
});

test("signs out from the dashboard by keyboard and cannot return", async ({
  page,
}) => {
  // Codex review of PR #6, finding F3: there was no way to end a session.
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("person@example.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");

  // The link the email would carry, opened in the same browser.
  await page.goto(`/auth/callback?code=${AUTH_CODE}`);
  await expect(page).toHaveURL(/\/dashboard$/);

  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("loads nothing from Cloudflare on an ordinary sign-in", async ({
  page,
}) => {
  // The challenge appears only past the global threshold (TASK-003c), so an
  // ordinary visitor's browser never contacts Cloudflare.
  const cloudflare: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.endsWith("cloudflare.com")) {
      cloudflare.push(request.url());
    }
  });

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("person@example.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");

  await expect(page.getByRole("group", { name: "Security check" })).toHaveCount(
    0,
  );
  expect(cloudflare).toEqual([]);
});

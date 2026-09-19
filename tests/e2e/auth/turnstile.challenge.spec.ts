import { expect, test } from "@playwright/test";

/**
 * Past the global magic-link threshold (TASK-003c), the form asks for a
 * Cloudflare Turnstile challenge. This drives the real widget with
 * Cloudflare's always-pass test keys, under the application's real CSP, and
 * the server verifies the token with Cloudflare's real siteverify. It needs
 * network access to challenges.cloudflare.com.
 *
 * The stub reports the global bucket full only while this file runs; the
 * project runs after every other spec (playwright.config.ts).
 */

// Kept in step with playwright.config.ts: the stub listens on the app port + 1.
const STUB_CONTROL = "http://127.0.0.1:3211/__control/threshold";

async function setThreshold(over: boolean) {
  const response = await fetch(STUB_CONTROL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ over }),
  });
  expect(response.ok).toBe(true);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await setThreshold(true);
});

test.afterAll(async () => {
  await setThreshold(false);
});

test("asks for a challenge past the threshold and sends the link once it passes", async ({
  page,
}) => {
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) {
      policyViolations.push(message.text());
    }
  });

  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("person@example.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();

  await expect(page.getByRole("status")).toContainText(
    "Complete the security check",
  );
  const challenge = page.getByRole("group", { name: "Security check" });
  await expect(challenge).toBeVisible();

  // Cloudflare's always-pass key solves itself and adds its token to the form.
  const token = page.locator('input[name="cf-turnstile-response"]');
  await expect(token).toHaveValue(/.+/, { timeout: 30_000 });

  await page.getByRole("button", { name: "Email me a sign-in link" }).click();

  await expect(page.getByRole("status")).toContainText("Check your email");
  await expect(challenge).toHaveCount(0);
  expect(policyViolations).toEqual([]);
});

test("reaches the challenge by keyboard before the submit button", async ({
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill("person@example.test");
  const submit = page.getByRole("button", { name: "Email me a sign-in link" });
  await submit.focus();
  await page.keyboard.press("Enter");

  const challenge = page.getByRole("group", { name: "Security check" });
  await expect(challenge).toBeVisible();
  // Focus stays on the button, as for every other answer.
  await expect(submit).toBeFocused();

  const inChallenge = await challenge.evaluate(
    (group, button) =>
      Boolean(
        group.compareDocumentPosition(button as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    await submit.elementHandle(),
  );
  expect(inChallenge).toBe(true);
});

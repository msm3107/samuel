import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

import { sharedSession } from "../support/shared-session";

/**
 * The disclosure screen in a real browser against the real local Supabase
 * (TASK-018): a member reaches it from the AI system page, publishes a
 * first notice, edits it into a second version and turns it off, all by
 * keyboard, with every stop's focus visible. Run with
 * `pnpm test:e2e:supabase`.
 *
 * Shares the run's one sign-in (TASK-015a, tests/e2e/support/shared-session
 * .ts, as ai-systems.supabase.spec.ts does): its own organization and AI
 * system, never signing out.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let systemUrl: string;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ storageState: sharedSession() });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
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
 * Presses Tab (or Shift+Tab) until `target` has focus, checking at every
 * stop on the way that the focused element shows an outline. Fails if
 * `target` is not reached: something on the way would be a keyboard trap,
 * or `target` is not focusable.
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

// Setting up an organization and an AI system to publish a notice under is
// not the flow this spec is about (TASK-018's disclosure screen), so, as
// the shared deployment spec does for its own setup step, it isn't done by
// keyboard.
test("sets up an organization and an AI system to carry the notice", async () => {
  const organizationName = `E2E Disclosure Org ${randomUUID().slice(0, 8)}`;
  const systemName = `Notice bot ${randomUUID().slice(0, 8)}`;

  await page.goto("/dashboard");
  await page.getByLabel("Organization name").fill(organizationName);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page
    .getByRole("main")
    .getByRole("link", { name: organizationName })
    .click();
  await expect(page).toHaveURL(/\/dashboard\/[0-9a-f-]{36}\/systems$/);

  await page.getByRole("link", { name: "Register an AI system" }).click();
  await expect(page).toHaveURL(/\/systems\/new$/);
  await page.getByLabel("Name", { exact: true }).fill(systemName);
  await page.getByLabel("Type", { exact: true }).selectOption("chatbot");
  await page.getByRole("button", { name: "Register", exact: true }).click();

  await expect(page).toHaveURL(/\/systems\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { level: 1, name: systemName }),
  ).toBeVisible();
  systemUrl = page.url();
});

test("reaches the disclosure screen, publishes, edits and turns the notice off, by keyboard alone", async () => {
  const main = page.getByRole("main");

  // From the AI system page: the disclosure link is reached and followed
  // by keyboard.
  await page.goto(systemUrl);
  await fromTheTop();
  const disclosureLink = main.getByRole("link", {
    name: "The transparency notice",
  });
  await tabTo(disclosureLink);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/disclosure$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Disclosure" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Write the notice" }),
  ).toBeVisible();

  const status = main.getByRole("status");
  const messageField = page.getByLabel("Notice", { exact: true });
  const languageField = page.getByLabel("Language", { exact: true });
  const enabledField = page.getByLabel("Show this notice on the website", {
    exact: true,
  });
  const publishButton = main.getByRole("button", {
    name: "Publish",
    exact: true,
  });
  // Scoped to the history, not the whole main: the editor's own textarea
  // shows the same published text right after a publish, and matching both
  // would be an ambiguous (strict-mode) locator.
  const history = main.getByRole("region", { name: "Published versions" });

  // First publish: message, language, and the "shown" checkbox left as it
  // starts (checked).
  const firstText = `We use an AI chatbot to answer questions. ${randomUUID().slice(0, 8)}`;
  await fromTheTop();
  await tabTo(messageField);
  await page.keyboard.type(firstText);
  // The counter says where the real limit is, counted as the server counts
  // it (PR #33 review, note 2).
  await expect(
    main.getByText(`${firstText.length} of 500 characters.`),
  ).toBeVisible();
  await tabTo(languageField, 1);
  await page.keyboard.type("English");
  await expect(languageField).toHaveValue("en");
  // Two stops: the "show this notice" checkbox sits between the language
  // and the button.
  await tabTo(publishButton, 2);
  await page.keyboard.press("Enter");

  await expect(status).toContainText(
    "Published. This is the current version now.",
  );
  await expect(
    page.getByRole("heading", { level: 2, name: "Publish a new version" }),
  ).toBeVisible();
  await expect(history.getByText("Version 1", { exact: false })).toBeVisible();
  await expect(history.getByText(firstText)).toBeVisible();

  // Second version: the message is replaced.
  const secondText = `We use an AI voice agent for support. ${randomUUID().slice(0, 8)}`;
  await fromTheTop();
  await tabTo(messageField);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(secondText);
  await tabTo(publishButton, 3);
  await page.keyboard.press("Enter");

  await expect(status).toContainText(
    "Published. This is the current version now.",
  );
  await expect(history.getByText("Version 2", { exact: false })).toBeVisible();
  await expect(history.getByText(secondText)).toBeVisible();

  // Third version: turned off, same text. The checkbox is reached and
  // unchecked with Space.
  await fromTheTop();
  await tabTo(enabledField);
  await expect(enabledField).toBeChecked();
  await page.keyboard.press("Space");
  await expect(enabledField).not.toBeChecked();
  await tabTo(publishButton, 2);
  await page.keyboard.press("Enter");

  await expect(status).toContainText(
    "Published. This is the current version now.",
  );

  // All three versions are in the history, newest first, the newest marked
  // current.
  await expect(history.getByText("Version 3", { exact: false })).toBeVisible();
  await expect(history.getByText("Version 2", { exact: false })).toBeVisible();
  await expect(history.getByText("Version 1", { exact: false })).toBeVisible();
  await expect(history.getByText("Current", { exact: true })).toBeVisible();
  // Versions 2 and 3 carry the same text: the third only turned it off.
  await expect(history.getByText(secondText)).toHaveCount(2);
  await expect(history.getByText(firstText)).toHaveCount(1);
  await expect(history).toContainText("Not shown");
});

/**
 * An older page of the history (TASK-018a). Three versions is fewer than a
 * page, so the screen itself offers no "Older versions" link; the cursor is
 * written by hand, as a stale link or an edited address would be, and the
 * page must still be right: the versions below it, no editor, and the way
 * back.
 */
test("an older page of the history shows no editor, and links back", async () => {
  const main = page.getByRole("main");

  await page.goto(`${systemUrl}/disclosure`);
  await expect(
    main.getByRole("heading", { name: "Published versions" }),
  ).toBeVisible();
  // Fewer than a page, so nothing is cut and no link to older is offered.
  await expect(main.getByRole("link", { name: "Older versions" })).toHaveCount(
    0,
  );

  await page.goto(`${systemUrl}/disclosure?before=3`);

  const history = main.getByRole("heading", { name: "Older versions" });
  await expect(history).toBeVisible();
  await expect(main).toContainText("Versions published before version 3.");
  // Exact, because Playwright's substring matching is case-insensitive and
  // the paragraph above says "before version 3".
  await expect(main.getByText("Version 2", { exact: true })).toBeVisible();
  await expect(main.getByText("Version 1", { exact: true })).toBeVisible();
  await expect(main.getByText("Version 3", { exact: true })).toHaveCount(0);
  // No editor at all on an older page: nothing here can publish.
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Publish" })).toHaveCount(0);
  await expect(main.getByText("Current", { exact: true })).toHaveCount(0);

  // The way back, by keyboard, as every other control on this screen.
  const back = main.getByRole("link", { name: "Back to the newest versions" });
  await fromTheTop();
  await tabTo(back);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/disclosure$/);
  await expect(
    main.getByRole("heading", { name: "Published versions" }),
  ).toBeVisible();
  await expect(main.getByText("Current", { exact: true })).toBeVisible();
});

/** A cursor someone typed wrong still shows the newest versions. */
test("a cursor that is not a version number shows the newest versions", async () => {
  const main = page.getByRole("main");

  await page.goto(`${systemUrl}/disclosure?before=nine`);

  await expect(
    main.getByRole("heading", { name: "Published versions" }),
  ).toBeVisible();
  await expect(main.getByText("Version 3", { exact: true })).toBeVisible();
  await expect(main.getByText("Current", { exact: true })).toBeVisible();
  await expect(
    main.getByRole("link", { name: "Back to the newest versions" }),
  ).toHaveCount(0);
});

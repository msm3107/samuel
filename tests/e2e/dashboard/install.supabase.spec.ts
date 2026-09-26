import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { sharedSession } from "../support/shared-session";

/**
 * The installation instructions on the deployment page (TASK-021), and the
 * only assertion that proves they are correct rather than merely present:
 * the snippet is read out of the rendered page and installed, unedited, on
 * a page at another origin, which then has to show the notice.
 *
 * An install document that drifts from the product is the failure this
 * whole task exists to prevent, so nothing here retypes the tag — what is
 * served to the customer's browser is the exact text a member would have
 * copied out of the dashboard.
 *
 * The customer's page is a real HTTP server on its own loopback port, for
 * the reason tests/e2e/public/widget.supabase.spec.ts gives: an intercepted
 * response has no address space Chrome can place, and its Local Network
 * Access check then refuses the request to the application.
 *
 * Run with `pnpm test:e2e:supabase`.
 */
test.describe.configure({ mode: "serial" });

/** Pages this run serves, by path. */
const fixtures = new Map<string, string>();

let server: Server;
let customer: string;
let context: BrowserContext;
let page: Page;
let appUrl: string;

let organizationId: string;
let systemId: string;
let deploymentUrl: string;
/** A deployment whose AI system has never published anything. */
let quietDeploymentUrl: string;
let message: string;

test.beforeAll(async ({ browser, baseURL }) => {
  context = await browser.newContext({ storageState: sharedSession() });
  page = await context.newPage();
  appUrl = baseURL ?? "";

  server = createServer((request, response) => {
    const body = fixtures.get(request.url ?? "");
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  customer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function post(path: string, data: unknown): Promise<unknown> {
    const response = await context.request.post(`${appUrl}${path}`, {
      headers: { origin: appUrl, "content-type": "application/json" },
      data,
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  }

  const organization = (await post("/api/organizations", {
    name: `Install ${randomUUID().slice(0, 8)}`,
  })) as { organization: { id: string } };
  organizationId = organization.organization.id;

  async function system(): Promise<string> {
    const created = (await post(
      `/api/organizations/${organizationId}/ai-systems`,
      {
        name: `Install system ${randomUUID().slice(0, 8)}`,
        systemType: "chatbot",
      },
    )) as { aiSystem: { id: string } };
    return created.aiSystem.id;
  }

  async function deployment(forSystem: string): Promise<string> {
    const registered = (await post(
      `/api/organizations/${organizationId}/deployments`,
      {
        aiSystemId: forSystem,
        hostname: `i${randomUUID().slice(0, 8)}.example.com`,
      },
    )) as { deployment: { id: string } };
    return `${appUrl}/dashboard/${organizationId}/deployments/${registered.deployment.id}`;
  }

  systemId = await system();
  message = `You are interacting with an AI system. ${randomUUID().slice(0, 8)}`;
  await post(
    `/api/organizations/${organizationId}/ai-systems/${systemId}/disclosures`,
    { message, language: "en", enabled: true, expectedVersion: null },
  );
  deploymentUrl = await deployment(systemId);
  quietDeploymentUrl = await deployment(await system());
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
});

/** The first snippet on the page: the tag a member is meant to paste. */
async function firstSnippet(): Promise<string> {
  const snippet = page.getByRole("region", { name: "Install" }).locator("pre");
  await expect(snippet.first()).toBeVisible();
  return (await snippet.first().textContent()) ?? "";
}

function customerPage(path: string, snippet: string): string {
  fixtures.set(
    path,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>A customer's site</title>
  </head>
  <body>
    <main><p id="theirs">Their own content.</p></main>
    ${snippet}
  </body>
</html>`,
  );
  return `${customer}${path}`;
}

test("the deployment page offers the tag, with this host and this deployment", async () => {
  await page.goto(deploymentUrl);

  const snippet = await firstSnippet();

  expect(snippet).toContain(`src="${appUrl}/widget.js"`);
  expect(snippet).toMatch(/data-deployment="dep_[a-z2-7]{26}"/);
  expect(snippet).toContain("async");
  // Only the public identifier: no database identifier reaches the page.
  await expect(page.locator("body")).not.toContainText(organizationId);

  await expect(
    page.getByText("This tag is showing the current notice to visitors."),
  ).toBeVisible();
  // The host to add to an existing policy, not a policy to paste: a site
  // that sends one already has these directives (PR #38 review, note 3).
  const install = page.getByRole("region", { name: "Install" });
  await expect(
    install.getByText("Add this host to your existing"),
  ).toBeVisible();
  await expect(install.getByText(appUrl, { exact: true })).toBeVisible();
  await expect(install.getByText(`script-src ${appUrl}`)).toHaveCount(0);
});

test("that exact snippet, pasted onto another origin, shows the notice", async () => {
  await page.goto(deploymentUrl);
  const snippet = await firstSnippet();

  // Unedited, on a different origin: the customer's site is 127.0.0.1 and
  // the application is localhost, so this is a real cross-origin install.
  const site = customerPage("/pasted", snippet);
  await page.goto(site);

  const notice = page.locator('[data-article50="notice"]');
  await expect(notice).toBeAttached();
  const text = await notice.evaluate(
    (host) => host.shadowRoot?.textContent ?? "",
  );
  expect(text).toBe(message);
  // The page it was pasted into is untouched.
  await expect(page.locator("#theirs")).toHaveText("Their own content.");
});

test("a deployment with nothing published says so, and still offers the tag", async () => {
  await page.goto(quietDeploymentUrl);

  await expect(
    page.getByText("No notice has been published for this AI system yet"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Publish a notice" }),
  ).toHaveAttribute("href", /\/disclosure$/);

  // Installable before anything is published: the tag is already correct,
  // and it starts showing the notice the moment one exists.
  const snippet = await firstSnippet();
  expect(snippet).toMatch(/data-deployment="dep_[a-z2-7]{26}"/);

  const site = customerPage("/not-yet", snippet);
  // Listening before the page loads, and waiting for the lookup itself to
  // answer rather than for a duration: the silence asserted below is the
  // silence after the widget has heard back, not before it asked.
  // What the widget itself says, as tests/e2e/public/widget.supabase.spec
  // .ts measures it. Chrome logs the 404 response on its own; that line is
  // the browser's, not the widget's, and no page can suppress it.
  const complaints: string[] = [];
  page.on("console", (entry) => {
    if (entry.text().includes("[article50]")) {
      complaints.push(entry.text());
    }
  });
  const answered = page.waitForResponse((response) =>
    response.url().includes("/api/public/disclosure/"),
  );
  await page.goto(site);
  expect((await answered).status()).toBe(404);

  // Nothing rendered, and nothing said: a deployment with nothing to show
  // is an ordinary state, and the widget is deliberately silent about it.
  await expect(page.locator('[data-article50="notice"]')).toHaveCount(0);
  expect(complaints).toEqual([]);
});

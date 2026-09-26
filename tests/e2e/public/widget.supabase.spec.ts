import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { sharedSession } from "../support/shared-session";

/**
 * The public widget on somebody else's page (TASK-020).
 *
 * The customer's page is served by a real HTTP server of its own, at a
 * different origin from the application, so the script tag, the CORS
 * request and the shadow root all behave as they will on a customer's
 * site. Everything below the widget is real: the built application serves
 * `/widget.js` and answers the lookup from the local database.
 *
 * The page is a real server rather than a route interception because
 * Chrome's Local Network Access checks refuse a request to loopback from a
 * page whose own address space it cannot place — which an intercepted
 * response has none of. Two loopback ports are two origins, so CORS is
 * still exercised in full; disabling the browser's check instead would
 * have tested a browser nobody uses.
 *
 * Run with `pnpm test:e2e:supabase`.
 */
test.describe.configure({ mode: "serial" });

/** Pages this run serves, by path. */
const fixtures = new Map<string, string>();

let server: Server;
let customer: string;
let context: BrowserContext;
let appUrl: string;

/** A deployment showing a notice, and one whose notice was withdrawn. */
let showing: string;
let withdrawn: string;
let message: string;

test.beforeAll(async ({ browser, baseURL }) => {
  context = await browser.newContext({ storageState: sharedSession() });
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
    name: `Widget ${randomUUID().slice(0, 8)}`,
  })) as { organization: { id: string } };
  const organizationId = organization.organization.id;

  async function deployment(): Promise<{ systemId: string; publicId: string }> {
    const system = (await post(
      `/api/organizations/${organizationId}/ai-systems`,
      {
        name: `Widget system ${randomUUID().slice(0, 8)}`,
        systemType: "chatbot",
      },
    )) as { aiSystem: { id: string } };
    const systemId = system.aiSystem.id;
    const registered = (await post(
      `/api/organizations/${organizationId}/deployments`,
      {
        aiSystemId: systemId,
        hostname: `w${randomUUID().slice(0, 8)}.example.com`,
      },
    )) as { deployment: { publicId: string } };
    return { systemId, publicId: registered.deployment.publicId };
  }

  async function publish(
    systemId: string,
    text: string,
    options: { enabled?: boolean; expectedVersion?: number | null } = {},
  ): Promise<void> {
    await post(
      `/api/organizations/${organizationId}/ai-systems/${systemId}/disclosures`,
      {
        message: text,
        language: "en",
        enabled: options.enabled ?? true,
        expectedVersion: options.expectedVersion ?? null,
      },
    );
  }

  // A message carrying markup, so the rendering test means something: this
  // is the last place a stored message could become HTML.
  message = `You are interacting with an AI system. <img src=x onerror="window.pwned=1"> ${randomUUID().slice(0, 8)}`;
  const shown = await deployment();
  await publish(shown.systemId, message);
  showing = shown.publicId;

  const gone = await deployment();
  await publish(
    gone.systemId,
    `Shown for a while. ${randomUUID().slice(0, 8)}`,
  );
  await publish(gone.systemId, `No longer shown. ${randomUUID().slice(0, 8)}`, {
    enabled: false,
    expectedVersion: 1,
  });
  withdrawn = gone.publicId;
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
});

type PageSetup = {
  /** Extra markup and styles the customer's page already has. */
  head?: string;
  body?: string;
  /** Attributes on the script tag, `data-deployment` included. */
  attributes?: Record<string, string>;
  /** Put the script in <head> rather than in the body. */
  inHead?: boolean;
};

function html(setup: PageSetup): string {
  const attributes = Object.entries(setup.attributes ?? {})
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  const script = `<script async src="${appUrl}/widget.js" ${attributes}></script>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>A customer's site</title>
    ${setup.head ?? ""}
    ${setup.inHead ? script : ""}
  </head>
  <body>
    <main><p id="theirs">Their own content.</p></main>
    ${setup.body ?? ""}
    ${setup.inHead ? "" : script}
  </body>
</html>`;
}

/** Opens the customer's page, collecting what the widget says and does. */
async function visit(setup: PageSetup): Promise<{
  page: Page;
  complaints: string[];
  crashes: string[];
  lookups: string[];
}> {
  const page = await context.newPage();
  const complaints: string[] = [];
  const crashes: string[] = [];
  const lookups: string[] = [];

  page.on("console", (entry) => {
    if (entry.text().includes("[article50]")) {
      complaints.push(entry.text());
    }
  });
  page.on("pageerror", (error) => crashes.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/public/")) {
      lookups.push(request.url());
    }
  });

  // A fresh path per visit, so no page is ever served from a cache.
  const path = `/${randomUUID()}`;
  fixtures.set(path, html(setup));
  await page.goto(`${customer}${path}`);
  return { page, complaints, crashes, lookups };
}

const notice = "div[data-article50='notice'] p.notice";

test("is served as one URL, revalidated hourly", async () => {
  const response = await context.request.get(`${appUrl}/widget.js`);

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("javascript");
  // One URL forever, an hour in the cache: a fix reaches every installed
  // site within the hour without anyone editing their page (owner,
  // 2026-09-26). Next serves public/ with no useful caching otherwise, so
  // this header is set in next.config.ts and asserted here because only a
  // built server can show it.
  expect(response.headers()["cache-control"]).toBe(
    "public, max-age=3600, stale-while-revalidate=86400",
  );
  // The application's own security headers reach it too.
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["strict-transport-security"]).toBe(
    "max-age=63072000; includeSubDomains; preload",
  );
});

test("renders the current notice on a cross-origin page", async () => {
  const { page, complaints, crashes } = await visit({
    attributes: { "data-deployment": showing },
  });

  await expect(page.locator(notice)).toHaveText(message);
  // The markup in the message is text, not an element, and nothing it
  // tried to do happened.
  await expect(page.locator(notice).locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => "pwned" in window)).toBe(false);
  // The version is readable without being shown.
  await expect(page.locator("div[data-article50='notice']")).toHaveAttribute(
    "data-version",
    "1",
  );
  expect(complaints).toEqual([]);
  expect(crashes).toEqual([]);
  await page.close();
});

test("keeps a hostile page's CSS out of the notice", async () => {
  const { page, crashes } = await visit({
    head: `<style>
        * { display: none !important; color: #ff0000 !important; font-size: 64px !important; }
        p { visibility: hidden !important; }
        .notice { background: #ff0000 !important; }
      </style>`,
    attributes: { "data-deployment": showing },
  });

  const paragraph = page.locator(notice);
  await expect(paragraph).toHaveText(message);

  // None of those rules reached inside the shadow root: a page cannot
  // restyle the notice by accident, however broad its selectors.
  //
  // What a page *can* do is style the host element, which lives in its own
  // DOM — `* { display: none !important }` hides it. That is deliberate
  // (owner, 2026-09-26): a customer who wants the notice gone can simply
  // not install it, and they carry the duty either way. Answering an
  // `!important` page rule with an `!important` of our own would also
  // override the customer's own styling, which is worse.
  expect(
    await paragraph.evaluate((element) => {
      const style = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement).fontSize;
      return {
        color: style.color,
        background: style.backgroundColor,
        visibility: style.visibility,
        // The page forced 64px on every element it can reach. The notice
        // is 0.875rem, so it follows the *root* font size — which is what
        // makes it respect a visitor who has enlarged their browser's
        // default text — and not the page's rule.
        fontSize: style.fontSize,
        expectedFromRoot: `${0.875 * Number.parseFloat(root)}px`,
        rootFontSize: root,
      };
    }),
  ).toEqual({
    color: "rgb(31, 41, 55)",
    background: "rgb(243, 244, 246)",
    visibility: "visible",
    fontSize: "56px",
    expectedFromRoot: "56px",
    rootFontSize: "64px",
  });
  expect(crashes).toEqual([]);
  await page.close();
});

test("renders on a page with aggressive but ordinary CSS, and takes no name of theirs", async () => {
  const { page, complaints, crashes } = await visit({
    head: `<style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        div { border: 6px solid #00ff00; color: #ff0000; font-size: 48px; }
        p { visibility: hidden; font-family: "Comic Sans MS"; }
      </style>
      <script>
        window.widget = "theirs";
        window.Article50 = "theirs";
        window.article50 = "theirs";
      </script>`,
    attributes: { "data-deployment": showing },
  });

  // The kind of CSS a real site has: a reset, element selectors, a
  // typography rule that would hide every paragraph on the page.
  await expect(page.locator(notice)).toBeVisible();
  await expect(page.locator(notice)).toHaveText(message);
  await expect(page.locator("#theirs")).toBeHidden();

  // And nothing of theirs was overwritten: the widget defines no global.
  expect(
    await page.evaluate(() => {
      const theirs = window as unknown as Record<string, unknown>;
      return {
        widget: theirs.widget,
        Article50: theirs.Article50,
        article50: theirs.article50,
      };
    }),
  ).toEqual({
    widget: "theirs",
    Article50: "theirs",
    article50: "theirs",
  });
  expect(complaints).toEqual([]);
  expect(crashes).toEqual([]);
  await page.close();
});

test("renders nothing, and says nothing, when the notice is withdrawn", async () => {
  const { page, complaints, crashes, lookups } = await visit({
    attributes: { "data-deployment": withdrawn },
  });

  await expect(page.locator("#theirs")).toBeVisible();
  await expect(page.locator("div[data-article50='notice']")).toHaveCount(0);
  // A deployment with nothing to show is a normal state: the request is
  // made, and the page is none the wiser.
  expect(lookups).toHaveLength(1);
  expect(complaints).toEqual([]);
  expect(crashes).toEqual([]);
  await page.close();
});

test("makes no request at all for a malformed identifier", async () => {
  const { page, complaints, crashes, lookups } = await visit({
    attributes: { "data-deployment": showing.toUpperCase() },
  });

  await expect(page.locator("#theirs")).toBeVisible();
  await expect(page.locator("div[data-article50='notice']")).toHaveCount(0);
  expect(lookups).toEqual([]);
  // A mistake in the installation is the installer's to see.
  expect(complaints).toHaveLength(1);
  expect(complaints[0]).toContain("data-deployment");
  expect(crashes).toEqual([]);
  await page.close();
});

test("asks for data-target when the script sits in the head", async () => {
  const { page, complaints, crashes } = await visit({
    inHead: true,
    attributes: { "data-deployment": showing },
  });

  await expect(page.locator("div[data-article50='notice']")).toHaveCount(0);
  expect(complaints).toHaveLength(1);
  expect(complaints[0]).toContain("data-target");
  expect(crashes).toEqual([]);
  await page.close();
});

test("renders into the element data-target names", async () => {
  const { page, complaints } = await visit({
    inHead: true,
    body: `<footer id="legal"></footer>`,
    attributes: { "data-deployment": showing, "data-target": "#legal" },
  });

  await expect(page.locator(`#legal ${notice}`)).toHaveText(message);
  expect(complaints).toEqual([]);
  await page.close();
});

test("writes no cookie and no storage entry", async () => {
  const { page } = await visit({ attributes: { "data-deployment": showing } });
  await expect(page.locator(notice)).toBeVisible();

  const stored = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
  }));
  const cookies = (await context.cookies(customer)).map(({ name }) => name);

  expect(stored).toEqual({ local: 0, session: 0, cookie: "" });
  expect(cookies).toEqual([]);
  await page.close();
});

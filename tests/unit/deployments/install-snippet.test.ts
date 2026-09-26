import { describe, expect, it } from "vitest";

import {
  buildInstallSnippet,
  WIDGET_PATH,
} from "@/features/deployments/install-snippet";

/**
 * The exact text a member copies out of the dashboard (TASK-021).
 *
 * These assertions are the bytes rather than a description of them: this
 * string goes onto somebody else's site, and the thing that makes it worth
 * generating is that it is right without being read.
 */

const PUBLIC_ID = "dep_7k2m4qphr6vt3wzc5nxa7jd2fb";
const APP_URL = "https://app.article50.example";

describe("the installation snippet", () => {
  it("is the documented installation, with this deployment's identifier", () => {
    const { tag } = buildInstallSnippet(PUBLIC_ID, APP_URL);

    expect(tag).toBe(
      `<script
  async
  src="https://app.article50.example/widget.js"
  data-deployment="dep_7k2m4qphr6vt3wzc5nxa7jd2fb"
></script>`,
    );
  });

  it("names a container when one is wanted, and nothing else changes", () => {
    const { tag, targetedTag } = buildInstallSnippet(PUBLIC_ID, APP_URL);

    expect(targetedTag).toBe(
      `<script
  async
  src="https://app.article50.example/widget.js"
  data-deployment="dep_7k2m4qphr6vt3wzc5nxa7jd2fb"
  data-target="#site-footer"
></script>`,
    );
    // The same tag with one attribute added, so the two cannot drift.
    expect(targetedTag.split("\n")).toEqual([
      ...tag.split("\n").slice(0, -1),
      '  data-target="#site-footer"',
      "></script>",
    ]);
  });

  it("offers the one host a customer adds to their existing directives", () => {
    // Not a policy to paste: a site that sends one already has `script-src`
    // and `connect-src`, and this host is added to them (PR #38 review,
    // note 3). The origin is what the screen shows, so the origin is what
    // is built.
    const { origin, scriptUrl } = buildInstallSnippet(PUBLIC_ID, APP_URL);

    expect(origin).toBe("https://app.article50.example");
    // The same host the script is loaded from, so the two cannot disagree.
    expect(scriptUrl.startsWith(`${origin}/`)).toBe(true);
  });

  it("serves the widget from the root, whatever path the app URL carries", () => {
    // `NEXT_PUBLIC_APP_URL` is only required to be a URL. A configured
    // trailing slash, port or path must not move `/widget.js`, which is
    // served from the root and only from there.
    for (const configured of [
      "https://app.article50.example",
      "https://app.article50.example/",
      "https://app.article50.example/dashboard",
      "https://app.article50.example/dashboard/",
    ]) {
      const { scriptUrl, origin } = buildInstallSnippet(PUBLIC_ID, configured);
      expect(scriptUrl).toBe(`https://app.article50.example${WIDGET_PATH}`);
      expect(origin).toBe("https://app.article50.example");
    }

    const local = buildInstallSnippet(PUBLIC_ID, "http://localhost:3000");
    expect(local.scriptUrl).toBe("http://localhost:3000/widget.js");
    expect(local.origin).toBe("http://localhost:3000");
  });

  it("refuses an identifier that is not a public deployment ID", () => {
    // A snippet carrying a malformed identifier is worse than none: the
    // widget refuses it in the browser and the customer blames their site.
    for (const wrong of [
      "",
      "dep_",
      PUBLIC_ID.toUpperCase(),
      PUBLIC_ID.slice(0, -1),
      `${PUBLIC_ID} `,
      // `1`, `8`, `9` and `0` are outside base32's a-z2-7.
      "dep_7k2m4qphr6vt3wzc5nxa9jd2fb",
      "00000000-0000-4000-8000-000000000000",
    ]) {
      expect(() => buildInstallSnippet(wrong, APP_URL)).toThrow(TypeError);
    }
  });

  it("puts nothing on the page but the public identifier", () => {
    const snippet = buildInstallSnippet(PUBLIC_ID, APP_URL);
    const everything = Object.values(snippet).join("\n");

    // No database identifier of any kind reaches the rendered section.
    expect(everything).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(everything.match(/dep_[a-z2-7]{26}/g)).toEqual([
      PUBLIC_ID,
      PUBLIC_ID,
    ]);
  });
});

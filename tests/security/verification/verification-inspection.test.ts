import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { WIDGET_PATH } from "@/features/deployments/install-snippet";
import type { VerificationFetchSuccess } from "@/features/verification/fetch-page";
import { inspectVerificationPage } from "@/features/verification/inspect-page";
import {
  verificationMetadataSchema,
  WIDGET_REASONS,
} from "@/features/verification/verification-check";
import { serverEnv } from "@/lib/env/server-env";

/**
 * HTML inspection and the failure-code mapping (TASK-024; README §18, §19).
 *
 * Under `tests/security/` because the question it answers is whether a page can
 * be made to look compliant without showing a visitor a notice. A false
 * positive here writes a success row for a site that discloses nothing, which
 * is the one error a compliance record must not make — so most of these tests
 * are negatives, and each one names the trick it refuses.
 */

const OURS = "dep_7k2m4qphr6vt3wzc5nxa7jd2fb";
const ANOTHER = "dep_2b3c4d5e6f7g2h3i4j5k6l7m2n";

/** Where the dashboard says to load the widget from, in this environment. */
const widgetUrl = new URL(
  WIDGET_PATH,
  serverEnv().NEXT_PUBLIC_APP_URL,
).toString();

/** The exact installation README §11 documents. */
function installation(deployment = OURS, src = widgetUrl): string {
  return `<script async src="${src}" data-deployment="${deployment}"></script>`;
}

/** A page of ordinary HTML with `body` in it. */
function html(body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><title>Shop</title></head><body><h1>Shop</h1>${body}</body></html>`;
}

function fetched(
  page: string | Buffer,
  options: Readonly<{ contentType?: string | null; finalUrl?: string }> = {},
): VerificationFetchSuccess {
  const body = typeof page === "string" ? Buffer.from(page, "utf8") : page;
  const contentType =
    options.contentType === undefined ? "text/html" : options.contentType;

  return Object.freeze({
    ok: true as const,
    httpStatus: 200,
    finalUrl: options.finalUrl ?? "https://shop.example.com/",
    body,
    metadata: {
      scheme: "https" as const,
      https_failed: false,
      redirects: 0,
      final_host: "shop.example.com",
      response_bytes: body.length,
      duration_ms: 120,
      ...(contentType === null ? {} : { content_type: contentType }),
    },
  });
}

describe("the installation the dashboard hands out", () => {
  it("is found", () => {
    const result = inspectVerificationPage(fetched(html(installation())), OURS);

    expect(result).toMatchObject({
      ok: true,
      widgetDetected: true,
      disclosureVersion: null,
    });
    expect(result.metadata).toMatchObject({ widget_tags: 1, charset: "utf-8" });
  });

  it("is found with data-target, and with the attributes in any order", () => {
    const tag = `<script data-deployment="${OURS}" data-target="#footer" src="${widgetUrl}" async></script>`;

    expect(inspectVerificationPage(fetched(html(tag)), OURS).ok).toBe(true);
  });

  it("is found when the tag carries a cache-busting query or a fragment", () => {
    // Our server serves the widget whatever the query says, so the tag loads
    // our code and the notice renders.
    for (const suffix of ["?v=2", "#x", "?v=2#x"]) {
      expect(
        inspectVerificationPage(
          fetched(html(installation(OURS, `${widgetUrl}${suffix}`))),
          OURS,
        ).ok,
      ).toBe(true);
    }
  });

  it("is found when the src is protocol-relative on a plain-HTTP page", () => {
    const { host } = new URL(widgetUrl);
    const result = inspectVerificationPage(
      fetched(html(installation(OURS, `//${host}${WIDGET_PATH}`)), {
        finalUrl: "http://shop.example.com/",
      }),
      OURS,
    );

    // Our host redirects to HTTPS and the browser follows, so this loads our
    // widget. The scheme is not part of the comparison for that reason.
    expect(result.ok).toBe(true);
  });

  it("is found on a page served without a Content-Type, as a browser sniffs", () => {
    expect(
      inspectVerificationPage(
        fetched(html(installation()), { contentType: null }),
        OURS,
      ).ok,
    ).toBe(true);
  });

  it("is found when a page carries the right tag beside another deployment's", () => {
    const page = html(installation(ANOTHER) + installation(OURS));
    const result = inspectVerificationPage(fetched(page), OURS);

    expect(result.ok).toBe(true);
    expect(result.metadata.widget_tags).toBe(2);
  });

  it("is found just before </body> on a page near the size bound", () => {
    const page = `<html><body>${"<p>x</p>".repeat(60_000)}${installation()}</body></html>`;

    expect(inspectVerificationPage(fetched(page), OURS).ok).toBe(true);
  });
});

describe("a page that carries the text of an installation but renders none", () => {
  it.each([
    ["a comment", `<!-- ${installation()} -->`],
    [
      "another script's body",
      `<script>var x = ${JSON.stringify(installation())};</script>`,
    ],
    ["a textarea", `<textarea>${installation()}</textarea>`],
    ["a title", `<title>${installation()}</title>`],
    ["an iframe's fallback", `<iframe>${installation()}</iframe>`],
    ["a noscript block", `<noscript>${installation()}</noscript>`],
    ["a template", `<template>${installation()}</template>`],
    ["another tag's attribute", `<div title='${installation()}'></div>`],
  ])("is not compliant when the tag is inside %s", (_where, body) => {
    const result = inspectVerificationPage(fetched(html(body)), OURS);

    expect(result).toMatchObject({
      ok: false,
      code: "WIDGET_NOT_FOUND",
      widgetDetected: false,
    });
    expect(result.metadata.widget_tags).toBe(0);
  });

  it("says nothing was found rather than that a tag was seen", () => {
    // A documentation page describing our installation is the honest example:
    // it has no tag, and the reason must not claim it had a broken one.
    const result = inspectVerificationPage(
      fetched(html(`<pre>&lt;script src="${widgetUrl}"&gt;</pre>`)),
      OURS,
    );

    expect(result).toMatchObject({ ok: false, reason: "NO_WIDGET_TAG" });
  });
});

describe("a copied widget", () => {
  it("is not presence, and says which host it was loaded from", () => {
    // The widget resolves its configuration endpoint from its own script URL,
    // so a copy asks the customer's host for a notice, gets their 404, and
    // renders nothing. The notice really is absent.
    const result = inspectVerificationPage(
      fetched(
        html(installation(OURS, `https://shop.example.com${WIDGET_PATH}`)),
      ),
      OURS,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "WIDGET_NOT_FOUND",
      widgetDetected: false,
      reason: "FOREIGN_ORIGIN",
    });
  });

  it("is still foreign when the src is relative to the customer's own page", () => {
    const result = inspectVerificationPage(
      fetched(html(installation(OURS, WIDGET_PATH))),
      OURS,
    );

    expect(result).toMatchObject({ ok: false, reason: "FOREIGN_ORIGIN" });
  });

  it("is reported as foreign rather than as no tag at all", () => {
    const result = inspectVerificationPage(
      fetched(
        html(`<script src="https://cdn.example.net${WIDGET_PATH}"></script>`),
      ),
      OURS,
    );

    expect(result).toMatchObject({ ok: false, reason: "FOREIGN_ORIGIN" });
  });
});

describe("a tag that cannot load the widget", () => {
  it.each([
    ["no src at all", `<script data-deployment="${OURS}"></script>`],
    ["an empty src", `<script src="" data-deployment="${OURS}"></script>`],
    [
      "a src that is not the widget",
      `<script src="https://cdn.example.net/a50.js" data-deployment="${OURS}"></script>`,
    ],
    [
      "a src that loads nothing a browser would fetch",
      `<script src="javascript:void 0" data-deployment="${OURS}"></script>`,
    ],
  ])("is NO_WIDGET_SRC when it has %s", (_what, body) => {
    const result = inspectVerificationPage(fetched(html(body)), OURS);

    expect(result).toMatchObject({
      ok: false,
      code: "WIDGET_NOT_FOUND",
      // "You have no tag" would be a false statement in evidence: they plainly
      // do have one.
      reason: "NO_WIDGET_SRC",
    });
  });
});

describe("our widget, loaded against the wrong deployment", () => {
  it("is DEPLOYMENT_ID_MISMATCH, and records that the script was present", () => {
    const result = inspectVerificationPage(
      fetched(html(installation(ANOTHER))),
      OURS,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "DEPLOYMENT_ID_MISMATCH",
      // §18 asks two questions. Article50.js *was* present; the expected
      // deployment ID was not.
      widgetDetected: true,
      reason: "OTHER_DEPLOYMENT",
    });
  });

  it("is a mismatch when the tag carries no identifier", () => {
    expect(
      inspectVerificationPage(
        fetched(html(`<script async src="${widgetUrl}"></script>`)),
        OURS,
      ),
    ).toMatchObject({
      ok: false,
      code: "DEPLOYMENT_ID_MISMATCH",
      widgetDetected: true,
      reason: "NO_DEPLOYMENT_ID",
    });
  });

  it.each([
    ["dep_NOTBASE32"],
    ["dep_short"],
    [""],
    [` ${OURS} `],
    [OURS.toUpperCase()],
  ])("is a malformed identifier for %j", (spelling) => {
    // Exactly the widget's own rule: no trimming and no case folding, so one
    // deployment has one spelling.
    expect(
      inspectVerificationPage(fetched(html(installation(spelling))), OURS),
    ).toMatchObject({
      ok: false,
      code: "DEPLOYMENT_ID_MISMATCH",
      reason: "MALFORMED_DEPLOYMENT_ID",
    });
  });

  it("reports the first of several tags, in document order", () => {
    const page = html(
      `<script src="${widgetUrl}"></script>${installation(ANOTHER)}`,
    );
    const result = inspectVerificationPage(fetched(page), OURS);

    expect(result).toMatchObject({ reason: "NO_DEPLOYMENT_ID" });
    expect(result.metadata.widget_tags).toBe(2);
  });
});

describe("a body that is not HTML", () => {
  it.each([
    ["application/pdf"],
    ["text/plain"],
    ["application/json"],
    ["image/png"],
  ])("is not scanned when the Content-Type is %j", (contentType) => {
    // A browser shows these as something other than a page, so no notice
    // renders, and a tag found inside one is a tag that never runs.
    const result = inspectVerificationPage(
      fetched(html(installation()), { contentType }),
      OURS,
    );

    expect(result).toMatchObject({
      ok: false,
      code: "WIDGET_NOT_FOUND",
      reason: "NOT_HTML",
    });
    // Nothing was decoded and nothing was counted, and a zero would claim a
    // scan that did not happen.
    expect(result.metadata.widget_tags).toBeUndefined();
    expect(result.metadata.charset).toBeUndefined();
    expect(result.metadata.content_type).toBe(contentType);
  });

  it("is scanned for XHTML, which a browser renders as a page", () => {
    expect(
      inspectVerificationPage(
        fetched(html(installation()), {
          contentType: "application/xhtml+xml; charset=utf-8",
        }),
        OURS,
      ).ok,
    ).toBe(true);
  });
});

describe("a page that is not UTF-8", () => {
  it("is decoded before it is searched, and says what it was read as", () => {
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1252"></head><body>'),
      // A byte that is not valid UTF-8 on its own, immediately before the tag.
      Buffer.from([0xa9]),
      Buffer.from(`${installation()}</body></html>`),
    ]);
    const result = inspectVerificationPage(
      fetched(body, { contentType: "text/html" }),
      OURS,
    );

    expect(result.ok).toBe(true);
    expect(result.metadata.charset).toBe("windows-1252");
  });
});

describe("what the result may be stored as", () => {
  it("produces metadata the row schema accepts, on every path", () => {
    const pages: readonly VerificationFetchSuccess[] = [
      fetched(html(installation())),
      fetched(html(installation(ANOTHER))),
      fetched(html("<p>nothing here</p>")),
      fetched(html(installation()), { contentType: "application/pdf" }),
      fetched(html(installation(OURS, WIDGET_PATH))),
    ];

    for (const page of pages) {
      const result = inspectVerificationPage(page, OURS);

      expect(
        verificationMetadataSchema.safeParse(result.metadata).success,
      ).toBe(true);
    }
  });

  it("never stores an identifier read off the customer's page", () => {
    // It would belong to another organization: a cross-tenant leak through the
    // one column README §34 exists to protect.
    const result = inspectVerificationPage(
      fetched(html(installation(ANOTHER))),
      OURS,
    );

    expect(JSON.stringify(result.metadata)).not.toContain(ANOTHER);
  });

  it("stores only reasons the row schema knows", () => {
    expect(
      verificationMetadataSchema.shape.widget_reason.unwrap().options,
    ).toEqual([...WIDGET_REASONS]);
  });

  it("never reports a disclosure version, on any path", () => {
    // The version the widget renders comes from our own endpoint after a
    // fetch, so it is never in the customer's HTML. DISCLOSURE_VERSION_MISMATCH
    // waits for §18's isolated browser environment.
    for (const body of [installation(), installation(ANOTHER), "<p>x</p>"]) {
      expect(
        inspectVerificationPage(fetched(html(body)), OURS).disclosureVersion,
      ).toBeNull();
    }
  });
});

describe("the public surface", () => {
  it("takes the expected origin from the environment, not from a caller", () => {
    // PR #40 note 3's lesson: a caller who could pass the origin could pass the
    // customer's own, and every self-hosted copy would verify as present.
    expect(inspectVerificationPage.length).toBe(2);
  });

  it("refuses an expected identifier that is not one", () => {
    // Our validation gap, not a customer's failed check: better no row than a
    // WIDGET_NOT_FOUND against a deployment nobody can name.
    expect(() =>
      inspectVerificationPage(fetched(html(installation())), "not-an-id"),
    ).toThrow(TypeError);
  });
});

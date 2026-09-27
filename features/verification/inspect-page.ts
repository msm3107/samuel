import "server-only";

import { WIDGET_PATH } from "@/features/deployments/install-snippet";
import { decodeBody } from "@/features/verification/decode-body";
import { findHtmlTags, type HtmlTag } from "@/features/verification/html-scan";
import {
  type VerificationMetadata,
  type WidgetReason,
} from "@/features/verification/verification-check";
import { serverEnv } from "@/lib/env/server-env";
import { isPublicDeploymentId } from "@/lib/security/public-id";

import type { VerificationFetchSuccess } from "@/features/verification/fetch-page";

/**
 * Was Article50.js present, and was the expected deployment ID present
 * (TASK-024; README §18, §19)?
 *
 * Those are the two of §18's four questions that HTML inspection can answer.
 * TASK-023 answered the first — was the website reachable. The fourth, whether
 * the expected disclosure version was observable, **cannot be answered here at
 * all**: the version the widget renders comes from our own endpoint after a
 * `fetch`, so it is never in the customer's HTML. `DISCLOSURE_VERSION_MISMATCH`
 * is therefore emitted by nothing in this module and `disclosureVersion` is
 * null in every result, until §18's isolated browser environment exists
 * (owner, 2026-09-27). Recording the version from our own database was the
 * alternative, and it was refused: it would assert something the page never
 * showed.
 *
 * ## What presence means
 *
 * A `<script>` whose `src` resolves to this installation's host and
 * `/widget.js` (owner, 2026-09-27). The HTML contains nothing else of ours —
 * the notice is rendered by JavaScript this task will not execute — so the tag
 * is the observable fact, and it carries both answerable questions in one
 * place.
 *
 * A tag pointing at a copy of `widget.js` on the customer's own domain is not
 * presence. The widget resolves its configuration endpoint from its own script
 * URL, so a copy asks the customer's host for a notice, receives their 404,
 * and renders nothing: the notice really is absent, and a success row would be
 * false evidence in the direction that matters most. `FOREIGN_ORIGIN` records
 * that this is what happened, because it is the one fact that tells the
 * customer what to change.
 *
 * ## Where the expected host comes from
 *
 * `serverEnv()`, never a parameter. PR #40 note 3's lesson, one module later:
 * a caller who could pass the origin could pass the customer's own, and every
 * self-hosted copy would verify as present. The public identifier *is* the
 * caller's, because it names which deployment is being checked; the origin is
 * not, because it is the same for every check this installation performs.
 *
 * `WIDGET_PATH` is imported from the module that builds the installation a
 * member copies out of the dashboard (TASK-021). One constant, so verification
 * cannot end up looking for a path the dashboard never hands out — a
 * disagreement that would show up as every customer failing at once.
 */

/** What this module concludes, for the row TASK-025 writes. */
export type PageInspection =
  | Readonly<{
      ok: true;
      widgetDetected: true;
      /** Never observed by HTML inspection; see above. */
      disclosureVersion: null;
      metadata: VerificationMetadata;
    }>
  | Readonly<{
      ok: false;
      /**
       * Both codes were reserved by TASK-022. This task adds none: §19's set
       * already had the two an HTML inspection can reach.
       */
      code: "WIDGET_NOT_FOUND" | "DEPLOYMENT_ID_MISMATCH";
      /**
       * True with a failure code when the script was found and its identifier
       * was not ours — §18 asks two questions, and that is the honest pair of
       * answers. TASK-022's schema permits it deliberately: it constrains only
       * that a *success* means the widget was found.
       */
      widgetDetected: boolean;
      disclosureVersion: null;
      reason: WidgetReason;
      metadata: VerificationMetadata;
    }>;

/** The media types a browser renders as HTML. */
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Whether a body is HTML worth scanning.
 *
 * An absent `Content-Type` is scanned, because a browser sniffs it and renders
 * the page. A `text/plain` body carrying markup is not: a browser shows it as
 * text, no notice appears, and a tag found in it is a tag that never runs.
 */
function isHtml(contentType: string | null): boolean {
  if (contentType === null) {
    return true;
  }
  const essence = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return essence === "" || HTML_TYPES.has(essence);
}

/**
 * The URL a `src` attribute names, resolved against the page it was found on,
 * or null if it is not one.
 *
 * Only `http:` and `https:` can load our widget, so a `data:` or `javascript:`
 * URL is not a candidate however it is spelled.
 */
function scriptUrl(tag: HtmlTag, pageUrl: string): URL | null {
  const src = tag.attributes.get("src");
  if (src === undefined || src.trim() === "") {
    return null;
  }
  try {
    const url = new URL(src.trim(), pageUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Whether a tag loads this installation's widget.
 *
 * The host as `URL` normalizes it, and the path exactly. The scheme, the query
 * and the fragment are ignored on purpose: a protocol-relative
 * `//host/widget.js` on a plain-HTTP page resolves to `http://host/widget.js`,
 * which is still our widget because our host redirects to HTTPS and the
 * browser follows; and a cache-busting `?v=2` still loads it, because our
 * server serves it whatever the query says. Neither costs anything, because
 * this is not authentication of the customer's page — it is reading their
 * installation, and the tag either loads our code or it does not.
 */
function isOurWidget(url: URL | null, expected: URL): boolean {
  return (
    url !== null &&
    url.host === expected.host &&
    url.pathname === expected.pathname
  );
}

/** A copy of the widget, served from somewhere that is not this installation. */
function isForeignWidget(url: URL | null, expected: URL): boolean {
  return (
    url !== null &&
    url.pathname === expected.pathname &&
    url.host !== expected.host
  );
}

/**
 * Why no tag of ours was found, from the most actionable observation
 * available. `FOREIGN_ORIGIN` comes first because it is the most specific: a
 * tag that both carries an identifier and loads a copy is a copy, and that is
 * the thing to fix.
 */
function absenceReason(
  tags: readonly HtmlTag[],
  pageUrl: string,
  expected: URL,
): WidgetReason {
  if (tags.some((tag) => isForeignWidget(scriptUrl(tag, pageUrl), expected))) {
    return "FOREIGN_ORIGIN";
  }
  // A tag carrying our attribute but loading something else is an attempt at
  // the installation, so "no tag" would be a false statement in evidence.
  if (tags.some((tag) => tag.attributes.has("data-deployment"))) {
    return "NO_WIDGET_SRC";
  }
  return "NO_WIDGET_TAG";
}

/**
 * Why the first of our tags does not name the deployment being checked.
 *
 * The first in document order, not a precedence over the reasons: it is
 * deterministic, it needs no table, and it is the tag a reader of the page
 * meets first. A page with several installations is already outside what the
 * widget documents, and `widget_tags` records that it had several.
 */
function mismatchReason(tag: HtmlTag): WidgetReason {
  const id = tag.attributes.get("data-deployment");
  if (id === undefined) {
    return "NO_DEPLOYMENT_ID";
  }
  return isPublicDeploymentId(id)
    ? "OTHER_DEPLOYMENT"
    : "MALFORMED_DEPLOYMENT_ID";
}

/**
 * Inspects a fetched page for one deployment's installation.
 *
 * @param page TASK-023's successful fetch, whose `metadata` this result
 *   extends rather than replaces — so TASK-025 stores one object and cannot
 *   assemble it wrongly.
 * @param expectedPublicId The deployment's public identifier. Refused if it is
 *   not one: that is our validation gap, not a customer's failed check, and
 *   inventing a `WIDGET_NOT_FOUND` row for it would write false evidence
 *   (PR #40 review, note 4).
 */
export function inspectVerificationPage(
  page: VerificationFetchSuccess,
  expectedPublicId: string,
): PageInspection {
  if (!isPublicDeploymentId(expectedPublicId)) {
    throw new TypeError("A public deployment identifier is required");
  }

  const contentType = page.metadata.content_type ?? null;
  if (!isHtml(contentType)) {
    return Object.freeze({
      ok: false as const,
      code: "WIDGET_NOT_FOUND" as const,
      widgetDetected: false,
      disclosureVersion: null,
      reason: "NOT_HTML" as const,
      // No `charset` and no `widget_tags`: nothing was decoded and nothing was
      // counted, and a zero here would claim a scan that did not happen. The
      // `Content-Type` is already in the metadata, so the row explains itself.
      metadata: page.metadata,
    });
  }

  const expected = new URL(WIDGET_PATH, serverEnv().NEXT_PUBLIC_APP_URL);
  const { text, charset } = decodeBody(page.body, contentType);
  const tags = findHtmlTags(text, "script");
  const ours = tags.filter((tag) =>
    isOurWidget(scriptUrl(tag, page.finalUrl), expected),
  );

  const metadata: VerificationMetadata = {
    ...page.metadata,
    charset,
    // A count, never an identifier: a deployment ID read off the page belongs
    // to some other organization, and putting it in this organization's
    // evidence row would be a cross-tenant leak through the column §34 exists
    // to protect.
    widget_tags: ours.length,
  };

  const first = ours[0];
  if (first === undefined) {
    const reason = absenceReason(tags, page.finalUrl, expected);
    return Object.freeze({
      ok: false as const,
      code: "WIDGET_NOT_FOUND" as const,
      widgetDetected: false,
      disclosureVersion: null,
      reason,
      metadata: Object.freeze({ ...metadata, widget_reason: reason }),
    });
  }

  if (
    ours.some(
      (tag) => tag.attributes.get("data-deployment") === expectedPublicId,
    )
  ) {
    return Object.freeze({
      ok: true as const,
      widgetDetected: true as const,
      disclosureVersion: null,
      metadata: Object.freeze(metadata),
    });
  }

  const reason = mismatchReason(first);
  return Object.freeze({
    ok: false as const,
    code: "DEPLOYMENT_ID_MISMATCH" as const,
    // The script was present. Only its identifier was not ours.
    widgetDetected: true,
    disclosureVersion: null,
    reason,
    metadata: Object.freeze({ ...metadata, widget_reason: reason }),
  });
}

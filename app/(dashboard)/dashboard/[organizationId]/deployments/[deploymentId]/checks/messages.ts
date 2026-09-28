import type {
  RedirectReason,
  VerificationFailureCode,
  VerificationStatus,
  WidgetReason,
} from "@/features/verification/verification-check";

/**
 * What the verification history screen can say (TASK-027), each with fixed
 * text.
 *
 * The same arrangement as `HOSTNAME_MESSAGES` and for the same reason: a row
 * carries a code, and the page shows the text this file keys by it. Nothing a
 * server chose, and nothing a customer's page contained, is put on the screen
 * as a message.
 *
 * Every table here is total over its vocabulary, asserted by a unit test with
 * `satisfies Record<…, …>` behind it, so a code added to §19 or a reason added
 * to `WIDGET_REASONS` fails a test rather than rendering a blank.
 *
 * No word of §21's forbidden vocabulary appears anywhere in this file, and a
 * test says so. This is the first screen whose subject is evidence, which makes
 * it the first place "certified" or "compliant" would be tempting and wrong: it
 * records what a check observed, and nothing more.
 */

export function checksPath(
  organizationId: string,
  deploymentId: string,
  before?: string,
): string {
  const path = `/dashboard/${organizationId}/deployments/${deploymentId}/checks`;
  return before === undefined
    ? path
    : `${path}?before=${encodeURIComponent(before)}`;
}

/** What a check's outcome is called. Never a colour, and never a glyph alone. */
export const CHECK_STATUS_LABELS = {
  success: "Passed",
  failure: "Failed",
} as const satisfies Record<VerificationStatus, string>;

/**
 * What a check looked for, said once at the top of the screen. §18's four
 * questions, minus the fourth: HTML inspection cannot observe which version of
 * a notice a visitor is shown, and the screen does not imply that it can.
 */
export const WHAT_A_CHECK_DOES =
  "Each check fetches this deployment's home page and looks for the Article50.js tag and this deployment's public ID in it. It reads the page only; it never runs the site's code.";

/**
 * The schedule, as a statement about verification rather than a promise about
 * this deployment (owner, 2026-09-28). The schedule is enabled outside the
 * application, so a screen that named a time would be asserting something the
 * application cannot know.
 */
export const CHECK_SCHEDULE = "Active deployments are checked once a day.";

type Explanation = Readonly<{
  /** Two or three words, for a row in the list. */
  label: string;
  /** What happened and what to change, for the panel. One or two sentences. */
  detail: string;
}>;

/**
 * Why a check failed (§19). The label is what a row shows; the detail is what
 * the newest check's panel shows.
 *
 * Several of these describe a site that is simply down, and they say so without
 * implying the customer did something wrong — a failed check is evidence about
 * a moment, not a verdict about a site.
 */
export const FAILURE_CODE_EXPLANATIONS = {
  DNS_ERROR: {
    label: "Hostname not found",
    detail:
      "The hostname could not be looked up, so nothing was fetched. Check that it is spelled the way visitors type it and that its DNS records are published.",
  },
  CONNECTION_FAILED: {
    label: "Could not connect",
    detail:
      // "a certificate the check could not accept" would read more precisely
      // here, and the word does not appear on this product's screens even in
      // its innocent sense (§21, §72).
      "The hostname resolved, but the connection was refused, reset or rejected. A site that is down, a firewall that blocks unknown visitors, or a secure connection the check could not complete all look like this.",
  },
  CONNECTION_TIMEOUT: {
    label: "Connection timed out",
    detail:
      "The site did not accept a connection within the time the check allows.",
  },
  TOTAL_TIMEOUT: {
    label: "Answer timed out",
    detail:
      "The connection opened, but the home page did not finish arriving within the time the check allows.",
  },
  HTTP_ERROR: {
    label: "Site returned an error",
    detail:
      "The home page answered with an error rather than a page, so there was nothing to look at.",
  },
  REDIRECT_BLOCKED: {
    label: "Redirect refused",
    detail:
      "The home page redirected somewhere the check will not follow, so the page it points at was never fetched.",
  },
  TOO_MANY_REDIRECTS: {
    label: "Too many redirects",
    detail:
      "The home page redirected more times than the check follows. A redirect loop looks like this.",
  },
  PRIVATE_NETWORK_BLOCKED: {
    label: "Private address",
    detail:
      "The hostname resolved to a private, local or reserved address, which cannot be reached from the internet and so cannot be checked.",
  },
  RESPONSE_TOO_LARGE: {
    label: "Page too large",
    detail:
      "The home page was larger than the check reads, so it was not scanned. The tag is usually in the first part of a page; a page this large may be sending something other than HTML.",
  },
  WIDGET_NOT_FOUND: {
    label: "Notice not found",
    detail:
      "The home page was fetched, but no working Article50.js tag was found on it.",
  },
  DEPLOYMENT_ID_MISMATCH: {
    label: "Different deployment",
    detail:
      "Article50.js is on the home page, but the tag does not name this deployment — so whatever notice that page shows, it is not this deployment's.",
  },
  DISCLOSURE_VERSION_MISMATCH: {
    label: "Version not confirmed",
    detail:
      "Reserved. Which version of a notice a visitor is shown arrives in the browser after the page loads, so reading the HTML cannot observe it and no check records this today.",
  },
  UNKNOWN_ERROR: {
    label: "Unexpected error",
    detail:
      "The check did not finish, for a reason we did not anticipate. It is recorded rather than dropped, so the history has no silent gap. Nothing on the site needs changing for it.",
  },
} as const satisfies Record<VerificationFailureCode, Explanation>;

/**
 * Which of the eight things the inspection found (TASK-024). This is the detail
 * `WIDGET_NOT_FOUND` and `DEPLOYMENT_ID_MISMATCH` cannot carry on their own,
 * and the reason the vocabulary was written: a missing tag, a copy served from
 * the customer's own host and a tag no browser will run are three different
 * fixes behind one code.
 */
export const WIDGET_REASON_EXPLANATIONS = {
  NOT_HTML: {
    label: "Not a web page",
    detail:
      "The address answered with something other than HTML — a PDF or a download, for example — so there was no page to scan. Check that this hostname's home page is the page visitors see.",
  },
  NO_WIDGET_TAG: {
    label: "No tag on the page",
    detail:
      "The home page carries no tag loading Article50.js. Copy the install code from the deployment page into the page's HTML.",
  },
  FOREIGN_ORIGIN: {
    label: "A copy on your own site",
    detail:
      "A tag loads Article50.js from your own site rather than from ours. A copy asks your site for the notice instead of asking us, gets nothing back, and shows nothing — so load the script from the address in the install code.",
  },
  NO_WIDGET_SRC: {
    label: "Tag loads another script",
    detail:
      "A tag carries a deployment ID, but the script it loads is not Article50.js. Check the address in its src against the install code.",
  },
  TAG_NOT_EXECUTED: {
    label: "Tag a browser will not run",
    detail:
      "The tag loads Article50.js from the right address, on an element no browser will execute — a type attribute that is not JavaScript, or nomodule on a plain script. The installation looks right and fetches nothing; remove the attribute and it will run.",
  },
  NO_DEPLOYMENT_ID: {
    label: "No deployment ID in the tag",
    detail:
      "Article50.js is loaded, but its tag carries no data-deployment attribute, so it does not know which notice to show. Add the attribute from the install code.",
  },
  MALFORMED_DEPLOYMENT_ID: {
    label: "Deployment ID unreadable",
    detail:
      "The data-deployment value is not a public ID. Copy it again from the deployment page.",
  },
  OTHER_DEPLOYMENT: {
    label: "Another deployment's ID",
    detail:
      "The tag carries a public ID that is not this deployment's. One page shows one deployment's notice, so if that page is meant to be this deployment's, replace the ID with this one.",
  },
} as const satisfies Record<WidgetReason, Explanation>;

/**
 * Which of the seven redirect rules refused a hop (PR #40 review, note 2). Six
 * causes needing six different fixes sit behind `REDIRECT_BLOCKED`, which is
 * why they are stored and why they are shown.
 */
export const REDIRECT_REASON_EXPLANATIONS = {
  INVALID_LOCATION: {
    label: "Redirect address unreadable",
    detail:
      "The redirect named an address that could not be read as one, so there was nowhere to follow it to.",
  },
  UNSUPPORTED_SCHEME: {
    label: "Unsupported redirect",
    detail:
      "The redirect pointed at something other than a web address. Only http and https are followed.",
  },
  SCHEME_DOWNGRADE: {
    label: "Redirect to http",
    detail:
      "The redirect went from https back to http. The check does not follow a downgrade, because what it reads afterwards could have been changed in transit.",
  },
  EMBEDDED_CREDENTIALS: {
    label: "Redirect carried a sign-in",
    detail:
      "The redirect address had a user name or password in it, which the check does not follow.",
  },
  PRIVATE_NETWORK_BLOCKED: {
    label: "Redirect to a private address",
    detail:
      "The redirect pointed at a private, local or reserved address. The check does not follow a redirect off the public internet.",
  },
  IP_ADDRESS_NOT_ALLOWED: {
    label: "Redirect to an IP address",
    detail:
      "The redirect pointed at a bare IP address rather than a hostname, which the check does not follow.",
  },
  PORT_NOT_ALLOWED: {
    label: "Redirect to another port",
    detail:
      "The redirect pointed at a port other than the standard 80 or 443, which the check does not follow.",
  },
} as const satisfies Record<RedirectReason, Explanation>;

/**
 * The reason to show beside a failure, or none.
 *
 * An unrecognized value renders as no detail rather than as an error: both
 * vocabularies are public from this task on, and a value added by a later
 * migration must not blank this screen or throw. The failure code's own
 * sentence still shows, so the reader is never left with nothing.
 */
export function reasonExplanation(check: {
  widgetReason: string | null;
  redirectReason: string | null;
}): Explanation | undefined {
  if (check.widgetReason !== null) {
    return lookUp(WIDGET_REASON_EXPLANATIONS, check.widgetReason);
  }
  if (check.redirectReason !== null) {
    return lookUp(REDIRECT_REASON_EXPLANATIONS, check.redirectReason);
  }
  return undefined;
}

function lookUp(
  table: Record<string, Explanation>,
  key: string,
): Explanation | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

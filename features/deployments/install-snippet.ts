import { isPublicDeploymentId } from "@/lib/security/public-id";

/**
 * The installation a member copies out of the dashboard (TASK-021).
 *
 * This is the documented installation from README §11, generated for one
 * deployment rather than typed by hand: one classic script tag, `async`,
 * `src` on this installation's own origin, and the deployment's public
 * identifier. A pure function, so the exact text customers paste is
 * asserted in a unit test rather than described by one.
 *
 * Nothing here is interpolated from anything a request chose. The public
 * identifier is the database's, in a shape the schema constrains, and the
 * host is `NEXT_PUBLIC_APP_URL` — the same value `lib/http/api.ts` trusts
 * as this deployment's own origin (owner, 2026-09-26).
 */

/** The one path the widget is served from (TASK-020). */
export const WIDGET_PATH = "/widget.js";

export type InstallSnippet = Readonly<{
  /** Absolute, for the script tag and for the policy entries alike. */
  scriptUrl: string;
  /** The application's origin, for the Content Security Policy entries. */
  origin: string;
  /** The tag to paste where the notice should appear. */
  tag: string;
  /** The same tag, rendering into a container the customer names. */
  targetedTag: string;
  /** What a site sending a Content Security Policy has to allow. */
  contentSecurityPolicy: string;
}>;

/**
 * Where a customer's example container is named. Fixed text in an example,
 * not a value: a deployment has no such thing to remember.
 */
const EXAMPLE_TARGET = "#site-footer";

/**
 * Builds the installation for one deployment.
 *
 * `appUrl` is resolved as a base, so a configured URL carrying a path or a
 * trailing slash still yields `https://host/widget.js` rather than
 * something relative to that path: the widget is served from the root and
 * only from there.
 *
 * @param publicId The deployment's public identifier, as the database
 *   issued it. Refused if it is not one, because a snippet with a
 *   malformed identifier is worse than none: the widget would refuse it in
 *   the browser and the customer would blame their site.
 */
export function buildInstallSnippet(
  publicId: string,
  appUrl: string,
): InstallSnippet {
  if (!isPublicDeploymentId(publicId)) {
    throw new TypeError("A public deployment identifier is required");
  }
  const { origin } = new URL(appUrl);
  const scriptUrl = new URL(WIDGET_PATH, appUrl).toString();
  const attributes = `\n  async\n  src="${scriptUrl}"\n  data-deployment="${publicId}"`;

  return Object.freeze({
    scriptUrl,
    origin,
    tag: `<script${attributes}\n></script>`,
    targetedTag: `<script${attributes}\n  data-target="${EXAMPLE_TARGET}"\n></script>`,
    // Both entries are the same host, built from it rather than written
    // out, so they cannot come to disagree with the `src` above them.
    contentSecurityPolicy: `script-src ${origin}\nconnect-src ${origin}`,
  });
}

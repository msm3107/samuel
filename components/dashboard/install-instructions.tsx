import Link from "next/link";

import {
  INSTALL_READINESS_MESSAGES,
  isNotShowing,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/messages";
import { buildInstallSnippet } from "@/features/deployments/install-snippet";
import type { InstallReadiness } from "@/features/deployments/install-readiness";
import { TEXT_LINK } from "@/components/ui/styles";

/**
 * How to install this deployment's notice (TASK-021): the exact script tag,
 * where to put it, and what a strict Content Security Policy has to allow.
 *
 * A server component with no JavaScript. The snippets are selected by one
 * click (`select-all`, the idiom the Public ID row above already uses) and
 * copied with the reader's own keyboard, which works where the asynchronous
 * clipboard API is refused and has nothing to announce to a screen reader.
 *
 * Only the public identifier reaches this component. No database
 * identifier, no organization, no hostname.
 */

/** One click selects a whole snippet; the reader presses Ctrl+C or ⌘C. */
const SNIPPET =
  "mt-2 overflow-x-auto rounded-md bg-slate-100 p-3 text-sm select-all";

export function InstallInstructions({
  publicId,
  appUrl,
  readiness,
  fix,
}: {
  publicId: string;
  /** `NEXT_PUBLIC_APP_URL`: the host every member is handed, not the one
      this request happened to arrive on. */
  appUrl: string;
  readiness: InstallReadiness;
  /** Where to go to make the tag render, when it would not today. */
  fix?: { href: string; label: string } | undefined;
}) {
  const snippet = buildInstallSnippet(publicId, appUrl);
  const notShowing = isNotShowing(readiness.state);

  return (
    <section className="mt-12" aria-labelledby="install-heading">
      <h2 id="install-heading" className="text-xl font-semibold">
        Install
      </h2>

      <p className="mt-4">
        {INSTALL_READINESS_MESSAGES[readiness.state]}
        {fix ? (
          <>
            {" "}
            <Link href={fix.href} className={TEXT_LINK}>
              {fix.label}
            </Link>
          </>
        ) : null}
      </p>
      {readiness.state === "live" || readiness.state === "disabled" ? (
        <p className="mt-1 text-sm text-slate-700">
          Version {readiness.version} is the current one.
        </p>
      ) : null}

      <p className="mt-6">
        {notShowing
          ? "Paste this into the page where the notice should appear. It starts showing the notice as soon as there is one to show:"
          : "Paste this into the page where the notice should appear:"}
      </p>
      <pre className={SNIPPET}>
        <code>{snippet.tag}</code>
      </pre>

      <h3 className="mt-8 font-medium">Somewhere else on the page</h3>
      <p className="mt-2">
        The notice renders where the tag sits. To put it in a container you
        already have, name that container with a CSS selector. A tag in{" "}
        <code>&lt;head&gt;</code> has no place on the page, so it needs one:
      </p>
      <pre className={SNIPPET}>
        <code>{snippet.targetedTag}</code>
      </pre>

      <h3 className="mt-8 font-medium">
        If your site sends a Content Security Policy
      </h3>
      <p className="mt-2">
        Add this host to your existing <code>script-src</code> and{" "}
        <code>connect-src</code> directives — one to load the script, one to let
        it fetch the notice. Your site already has a policy, so this is not two
        lines to paste:
      </p>
      {/* Deliberately not shaped like the snippets above: a policy is the one
          thing on this page that can never be copied whole, because the
          customer already has one (PR #38 review, note 3). */}
      <p className="mt-2">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 select-all">
          {snippet.origin}
        </code>
      </p>
      <p className="mt-2 text-sm text-slate-700">
        No <code>style-src</code> exception is needed: the notice is styled
        through a constructable stylesheet rather than an inline one, inside its
        own shadow root, so your site&apos;s CSS cannot reach it and its CSS
        cannot reach your site.
      </p>

      <p className="mt-6 text-sm text-slate-700">
        Load the script from this address rather than copying the file to your
        own site. It asks its own origin for the notice, so a copy asks your
        server instead and cannot find one. Use one ordinary script tag per
        deployment; <code>type=&quot;module&quot;</code> is not supported.
      </p>
    </section>
  );
}

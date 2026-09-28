import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { Breadcrumbs } from "@/components/dashboard/breadcrumbs";
import { Hostname } from "@/components/dashboard/hostname";
import { VerificationStatusBadge } from "@/components/dashboard/verification-status";
import { TEXT_LINK } from "@/components/ui/styles";
import { readDeployment } from "@/features/deployments/deployment-queries";
import {
  verificationCursorSchema,
  type SerializedVerificationCheck,
} from "@/features/verification/verification-check";
import {
  listVerificationChecks,
  VERIFICATION_LIST_LIMIT,
} from "@/features/verification/verification-history-queries";

import {
  organizationAccessOrNotFound,
  organizationOrNotFound,
} from "../../../access";
import { deploymentPath } from "../../messages";
import { systemsPath } from "../../../systems/messages";
import {
  CHECK_SCHEDULE,
  checksPath,
  FAILURE_CODE_EXPLANATIONS,
  reasonExplanation,
  WHAT_A_CHECK_DOES,
} from "./messages";

const deploymentIdSchema = z.uuid();

/** Always in UTC, said as such: the server doesn't know the reader's zone. */
const CHECKED_AT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

/**
 * The day a check covers. A window is a date — midnight UTC to midnight UTC —
 * so it is shown as one, with no time to imply a precision it does not have.
 */
const CHECK_DAY = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeZone: "UTC",
});

/**
 * One deployment's verification history (TASK-027; README §18-§20, §31, §35).
 *
 * Read-only, like the evidence it shows: no control on this page changes a
 * check, and none exists to add.
 *
 * `?before=` reads an older page (README §31). A cursor that cannot be read
 * shows the newest checks rather than a 404 — this screen's own links are
 * always well formed, so an unreadable one arrived from somewhere else and the
 * newest page is still the right answer. The API refuses the same value,
 * because a client calling it asked for something exact (TASK-018a's rule).
 */
export default async function VerificationChecksPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; deploymentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId, deploymentId } = await params;
  const access = await organizationAccessOrNotFound(
    organizationId,
    "organization.read",
  );
  const id = deploymentIdSchema.safeParse(deploymentId);
  if (!id.success) {
    notFound();
  }
  const before = historyCursor((await searchParams).before);
  const [organization, deployment, history] = await Promise.all([
    organizationOrNotFound(access),
    readDeployment(access, id.data),
    listVerificationChecks(
      access,
      id.data,
      before === undefined ? {} : { before },
    ),
  ]);
  // Either being null is the same 404, including for another organization's
  // deployment, so neither says anything about what exists.
  if (deployment === null || history === null) {
    notFound();
  }

  const paged = before !== undefined;
  // On an older page the first row is not the newest check, so nothing here
  // explains "what is happening now" — that panel belongs to the newest page.
  const newest = paged ? undefined : history.checks[0];
  const oldest = history.checks.at(-1);
  const toDeployment = deploymentPath(access.organizationId, deployment.id);

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-12">
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: organization.name },
          { label: "AI systems", href: systemsPath(access.organizationId) },
          // The ASCII form: a crumb is isolated with `dir="auto"`, which a
          // hostname must never get.
          { label: deployment.hostname, href: toDeployment },
          { label: "Verification" },
        ]}
      />
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">
        Verification checks
      </h1>
      <p className="mt-2 break-words text-slate-700">
        <Hostname
          hostname={deployment.hostname}
          unicodeHostname={deployment.unicodeHostname}
        />
      </p>
      <p className="mt-4 text-sm text-slate-700">{WHAT_A_CHECK_DOES}</p>

      {history.deploymentStatus === "archived" ? (
        <p role="note" className="mt-4 text-sm text-slate-700">
          This deployment is archived, so it is no longer checked. Everything
          recorded before it was archived is kept and shown below.
        </p>
      ) : null}

      {newest === undefined ? null : <LatestCheck check={newest} />}

      <section className="mt-12" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-xl font-semibold">
          {paged ? "Older checks" : "All checks"}
        </h2>
        {paged ? (
          <p className="mt-2 text-sm text-slate-700">
            Checks recorded before the one this page starts from. The newest is
            on the first page.
          </p>
        ) : null}

        {oldest === undefined ? (
          <p className="mt-4 text-slate-700">
            {paged
              ? "There are no checks older than this page."
              : `No checks recorded yet. ${CHECK_SCHEDULE}`}
          </p>
        ) : (
          <>
            <ol className="mt-4 divide-y divide-slate-200">
              {history.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ol>
            {history.truncated ? (
              // The count and the way to the rest in one sentence, so a reader
              // knows the list is cut before reaching its foot.
              <p className="mt-6 text-sm text-slate-700">
                Showing {paged ? "" : "the "}
                {VERIFICATION_LIST_LIMIT}
                {paged ? " checks" : " newest checks"}.{" "}
                <Link
                  href={checksPath(
                    access.organizationId,
                    deployment.id,
                    oldest.checkWindow,
                  )}
                  className={TEXT_LINK}
                >
                  Older checks
                </Link>
              </p>
            ) : null}
          </>
        )}

        {paged ? (
          <p className="mt-6 text-sm">
            <Link
              href={checksPath(access.organizationId, deployment.id)}
              className={TEXT_LINK}
            >
              Back to the newest checks
            </Link>
          </p>
        ) : null}
      </section>

      <p className="mt-12 text-sm">
        <Link href={toDeployment} className={TEXT_LINK}>
          Back to the deployment
        </Link>
      </p>
    </main>
  );
}

/**
 * The newest check, with what happened and what to change (owner, 2026-09-28).
 *
 * Only here, and only on the newest page: daily checks repeat the same failure
 * for as long as it takes to fix, and the same paragraph two hundred times
 * would stop the list below reading as a record of what happened.
 */
function LatestCheck({ check }: { check: SerializedVerificationCheck }) {
  const failure =
    check.failureCode === null
      ? undefined
      : FAILURE_CODE_EXPLANATIONS[check.failureCode];
  const reason = reasonExplanation(check);

  return (
    <section
      className="mt-8 rounded-md border border-slate-300 p-5"
      aria-labelledby="latest-heading"
    >
      <h2 id="latest-heading" className="text-xl font-semibold">
        Most recent check
      </h2>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <VerificationStatusBadge status={check.status} />
        {/* The day it covers, as in the list, and beneath it the moment it
            actually ran — which is the fact somebody reconstructing an
            incident wants, and the only place it is worth the room. */}
        <time dateTime={check.checkWindow} className="text-sm text-slate-700">
          {CHECK_DAY.format(new Date(check.checkWindow))}
        </time>
      </p>
      <p className="mt-1 text-sm text-slate-700">
        Checked at{" "}
        <time dateTime={check.checkedAt}>
          {CHECKED_AT.format(new Date(check.checkedAt))} UTC
        </time>
        .
      </p>

      {failure === undefined ? (
        <p className="mt-3 text-slate-700">
          The home page was fetched and this deployment&rsquo;s Article50.js tag
          was found on it.
        </p>
      ) : (
        <>
          <p className="mt-3 font-medium">{failure.label}</p>
          <p className="mt-1 text-slate-700">{failure.detail}</p>
          {/* The number is the fact a customer acts on here, and only here: a
              200 beside a tag that was not found explains nothing and invites
              the reading that the check half-succeeded. */}
          {check.failureCode === "HTTP_ERROR" && check.httpStatus !== null ? (
            <p className="mt-1 text-slate-700">
              The site answered {check.httpStatus}.
            </p>
          ) : null}
          {reason === undefined ? null : (
            <p className="mt-3 text-slate-700">
              <span className="font-medium text-slate-900">
                {reason.label}.
              </span>{" "}
              {reason.detail}
            </p>
          )}
        </>
      )}

      <p className="mt-4 text-sm text-slate-700">{CHECK_SCHEDULE}</p>
    </section>
  );
}

/**
 * One check, on one line: when, whether it passed, and — where it did not —
 * short labels for the code and the reason. No identifier a reader did not
 * navigate by, and nothing read off the customer's page.
 */
function CheckRow({ check }: { check: SerializedVerificationCheck }) {
  const failure =
    check.failureCode === null
      ? undefined
      : FAILURE_CODE_EXPLANATIONS[check.failureCode];
  const reason = reasonExplanation(check);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      {/* The window, not the moment the check ran. The list is ordered and
          paged by `checkWindow`, so labelling rows by `checkedAt` would let a
          row written late — a backfill, a retry — appear out of order in a
          record a customer relies on. It also makes the cursor visible: the
          date a reader sees on the last row is the value "Older checks"
          continues from (README §31). */}
      <time
        dateTime={check.checkWindow}
        className="w-40 shrink-0 text-sm text-slate-700 tabular-nums"
      >
        {CHECK_DAY.format(new Date(check.checkWindow))}
      </time>
      <VerificationStatusBadge status={check.status} />
      {failure === undefined ? null : (
        <span className="text-sm text-slate-700">
          {failure.label}
          {reason === undefined ? null : ` — ${reason.label}`}
        </span>
      )}
    </li>
  );
}

/**
 * Where an older page starts, or nowhere. A cursor that cannot be read — typed,
 * stale, or given twice — shows the newest checks rather than a 404, as the
 * disclosure history does (TASK-018a).
 */
function historyCursor(value: string | string[] | undefined): Date | undefined {
  const parsed = verificationCursorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

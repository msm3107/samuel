import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { Breadcrumbs } from "@/components/dashboard/breadcrumbs";
import { DisclosureForm } from "@/components/dashboard/disclosure-form";
import { TEXT_LINK } from "@/components/ui/styles";
import { readAiSystem } from "@/features/ai-systems/ai-system-queries";
import {
  disclosureCursorSchema,
  type SerializedDisclosure,
} from "@/features/disclosures/disclosure";
import {
  EMPTY_DISCLOSURE_FORM_VALUES,
  languageLabel,
} from "@/features/disclosures/disclosure-fields";
import { formValuesOf } from "@/features/disclosures/disclosure-form";
import {
  DISCLOSURE_LIST_LIMIT,
  listDisclosures,
} from "@/features/disclosures/disclosure-queries";
import { minimumRoleFor, roleSatisfies } from "@/lib/auth/organization-roles";

import {
  organizationAccessOrNotFound,
  organizationOrNotFound,
} from "../../../access";
import { systemPath, systemsPath } from "../../messages";
import { publishDisclosureAction } from "./actions";
import { disclosurePath } from "./messages";

const systemIdSchema = z.uuid();

/** Always in UTC, said as such: the server doesn't know the reader's zone. */
const PUBLISHED_AT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

/**
 * One AI system's disclosure (TASK-018). Viewers read the published
 * versions; members also write and publish here. A system this organization
 * does not have, including another organization's, is not found, and a
 * non-UUID is too, without a query.
 *
 * Every published version is permanent evidence, so the history shows each
 * one with its full text, newest first (owner, 2026-09-23). The first row is
 * the current version: the widget shows that one, if it is turned on.
 *
 * `?before=N` reads an older page (TASK-018a). On such a page the first row
 * is not the current version, so the editor is not rendered at all: a
 * publish against a stale version is impossible by the page's shape rather
 * than by the editor knowing which page it is on (owner, 2026-09-25).
 */
export default async function DisclosurePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; systemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId, systemId } = await params;
  const access = await organizationAccessOrNotFound(
    organizationId,
    "organization.read",
  );
  const id = systemIdSchema.safeParse(systemId);
  if (!id.success) {
    notFound();
  }
  const before = historyCursor((await searchParams).before);
  const [organization, aiSystem, history] = await Promise.all([
    organizationOrNotFound(access),
    readAiSystem(access, id.data),
    listDisclosures(access, id.data, { before }),
  ]);
  if (aiSystem === null || history === null) {
    notFound();
  }

  const canManage = roleSatisfies(
    access.role,
    minimumRoleFor("disclosures.manage"),
  );
  const archived = history.aiSystemStatus === "archived";
  const paged = before !== undefined;
  // Only the newest page knows what the current version is.
  const current = paged ? undefined : history.disclosures[0];
  const oldest = history.disclosures.at(-1);
  const newestPath = disclosurePath(access.organizationId, aiSystem.id);

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-12">
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: organization.name },
          { label: "AI systems", href: systemsPath(access.organizationId) },
          {
            label: aiSystem.name,
            href: systemPath(access.organizationId, aiSystem.id),
          },
          { label: "Disclosure" },
        ]}
      />
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Disclosure</h1>
      <p className="mt-2 text-slate-700">
        The transparency notice shown where <bdi>{aiSystem.name}</bdi> is used.
      </p>

      {canManage && !paged ? (
        <section className="mt-10" aria-labelledby="editor-heading">
          <h2 id="editor-heading" className="text-xl font-semibold">
            {current === undefined
              ? "Write the notice"
              : "Publish a new version"}
          </h2>
          {archived ? (
            // No dead control: the database refuses this anyway.
            <p className="mt-2 text-sm text-slate-700">
              This system is archived. Restore it to change its notice.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-700">
                Publishing keeps the version that is live now: it is added to
                the history below, and the new one becomes current.
              </p>
              <DisclosureForm
                action={publishDisclosureAction.bind(
                  null,
                  access.organizationId,
                  aiSystem.id,
                )}
                initialValues={
                  current === undefined
                    ? EMPTY_DISCLOSURE_FORM_VALUES
                    : formValuesOf(current)
                }
                initialVersion={current?.version}
              />
            </>
          )}
        </section>
      ) : null}

      <section className="mt-12" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-xl font-semibold">
          {paged ? "Older versions" : "Published versions"}
        </h2>
        {paged ? (
          <p className="mt-2 text-sm text-slate-700">
            Versions published before version {before}. The current version is
            on the newest page.
          </p>
        ) : null}
        {oldest === undefined ? (
          <p className="mt-4 text-slate-700">
            {paged
              ? `There are no versions older than version ${before}.`
              : "Nothing published yet. Until a notice is published and turned on, the widget shows nothing for this system."}
          </p>
        ) : (
          <>
            {current === undefined ? null : archived ? (
              <p role="note" className="mt-4 text-sm text-slate-700">
                This system is archived, so the widget shows nothing for it,
                whatever its notice says.
              </p>
            ) : current.enabled ? null : (
              <p role="note" className="mt-4 text-sm text-slate-700">
                The current version is turned off, so the widget shows nothing
                for this system.
              </p>
            )}
            <ol className="mt-4 space-y-6">
              {history.disclosures.map((disclosure, index) => (
                <Version
                  key={disclosure.id}
                  disclosure={disclosure}
                  current={!paged && index === 0}
                  byYou={disclosure.createdBy === access.userId}
                />
              ))}
            </ol>
            {history.truncated ? (
              // The count and the way to the rest in one sentence, so a
              // reader knows the list is cut before reaching its foot.
              <p className="mt-6 text-sm text-slate-700">
                Showing {paged ? "" : "the "}
                {DISCLOSURE_LIST_LIMIT}
                {paged ? " versions" : " newest versions"}.{" "}
                <Link
                  href={disclosurePath(
                    access.organizationId,
                    aiSystem.id,
                    oldest.version,
                  )}
                  className={TEXT_LINK}
                >
                  Older versions
                </Link>
              </p>
            ) : null}
          </>
        )}
        {paged ? (
          <p className="mt-6 text-sm">
            <Link href={newestPath} className={TEXT_LINK}>
              Back to the newest versions
            </Link>
          </p>
        ) : null}
      </section>
    </main>
  );
}

/**
 * Where an older page starts, or nowhere (TASK-018a). A cursor that cannot
 * be read — typed, stale, or given twice — shows the newest versions rather
 * than a 404, as the AI systems list does with an unknown status: the
 * screen's own links are always well formed, so an unreadable one came from
 * somewhere else and the page is still the right answer. The API refuses the
 * same value, because a client asked for something exact.
 */
function historyCursor(
  value: string | string[] | undefined,
): number | undefined {
  const parsed = disclosureCursorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One published version, with its text (TASK-018, owner 2026-09-23). The
 * message is plain text: rendered as text, never as markup, with its own
 * direction so a notice in another script reads correctly.
 *
 * The publisher is "you" or "another member": the database records a user
 * ID, and names and email addresses are not readable from the dashboard's
 * session client.
 */
function Version({
  disclosure,
  current,
  byYou,
}: {
  disclosure: SerializedDisclosure;
  current: boolean;
  byYou: boolean;
}) {
  return (
    <li className="border-b border-slate-200 pb-6 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-slate-700">
        <span className="font-medium text-slate-900">
          Version {disclosure.version}
        </span>
        {current ? (
          <span className="rounded-md border border-slate-400 px-2 py-0.5">
            Current
          </span>
        ) : null}
        <span>{languageLabel(disclosure.language)}</span>
        <span>{disclosure.enabled ? "Shown" : "Not shown"}</span>
      </div>
      <p dir="auto" className="mt-2 break-words whitespace-pre-line">
        {disclosure.message}
      </p>
      <p className="mt-2 text-sm text-slate-700">
        Published <UtcTime value={disclosure.createdAt} /> by{" "}
        {byYou ? "you" : "another member"}.
      </p>
    </li>
  );
}

/**
 * A time as UTC, said as such, in a `<time>` carrying the exact value: the
 * server renders the page and does not know the reader's time zone
 * (TASK-015), as on the deployment screen.
 */
function UtcTime({ value }: { value: string }) {
  return (
    <time dateTime={value}>{PUBLISHED_AT.format(new Date(value))} UTC</time>
  );
}

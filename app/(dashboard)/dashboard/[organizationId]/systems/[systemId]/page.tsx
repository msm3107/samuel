import { notFound } from "next/navigation";
import { z } from "zod";

import { AiSystemForm } from "@/components/dashboard/ai-system-form";
import { AiSystemStatusForm } from "@/components/dashboard/ai-system-status-form";
import { Breadcrumbs } from "@/components/dashboard/breadcrumbs";
import {
  formValuesOf,
  SYSTEM_TYPE_LABELS,
} from "@/features/ai-systems/ai-system-form";
import { readAiSystem } from "@/features/ai-systems/ai-system-queries";
import { minimumRoleFor, roleSatisfies } from "@/lib/auth/organization-roles";

import {
  organizationAccessOrNotFound,
  organizationOrNotFound,
} from "../../access";
import { setAiSystemStatusAction, updateAiSystemAction } from "../actions";
import { systemsPath } from "../messages";

const systemIdSchema = z.uuid();

/**
 * One AI system (TASK-010). Viewers read it; members also edit, archive and
 * restore it here. A system this organization does not have, including
 * another organization's, is not found, and a non-UUID is too, without a
 * query.
 */
export default async function AiSystemPage({
  params,
}: {
  params: Promise<{ organizationId: string; systemId: string }>;
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
  const [organization, aiSystem] = await Promise.all([
    organizationOrNotFound(access),
    readAiSystem(access, id.data),
  ]);
  if (aiSystem === null) {
    notFound();
  }
  const canManage = roleSatisfies(
    access.role,
    minimumRoleFor("systems.manage"),
  );
  const archived = aiSystem.status === "archived";

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-12">
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: organization.name },
          { label: "AI systems", href: systemsPath(access.organizationId) },
          { label: aiSystem.name },
        ]}
      />
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">
        <bdi>{aiSystem.name}</bdi>
      </h1>

      <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3">
        <dt className="font-medium">Status</dt>
        <dd>{archived ? "Archived" : "Active"}</dd>
        <dt className="font-medium">Type</dt>
        <dd>{SYSTEM_TYPE_LABELS[aiSystem.systemType]}</dd>
        <dt className="font-medium">Provider</dt>
        <dd>
          {aiSystem.provider === null ? (
            <span className="text-slate-600">Not given</span>
          ) : (
            <bdi>{aiSystem.provider}</bdi>
          )}
        </dd>
        <dt className="font-medium">Description</dt>
        <dd>
          {aiSystem.description === null ? (
            <span className="text-slate-600">Not given</span>
          ) : (
            // Kept apart from the page's direction, with its line breaks.
            <p dir="auto" className="whitespace-pre-line">
              {aiSystem.description}
            </p>
          )}
        </dd>
      </dl>

      {canManage ? (
        <>
          <section className="mt-12" aria-labelledby="edit-heading">
            <h2 id="edit-heading" className="text-xl font-semibold">
              Edit
            </h2>
            <AiSystemForm
              action={updateAiSystemAction.bind(
                null,
                access.organizationId,
                aiSystem.id,
              )}
              initialValues={formValuesOf(aiSystem)}
              initialVersion={aiSystem.updatedAt}
              submitLabel="Save changes"
              pendingLabel="Saving…"
            />
          </section>

          <section className="mt-12" aria-labelledby="status-heading">
            <h2 id="status-heading" className="text-xl font-semibold">
              {archived ? "Restore" : "Archive"}
            </h2>
            <div className="mt-4">
              {/* One form whichever way it goes, so the result it announces
                  survives the page re-rendering with the new status. */}
              <AiSystemStatusForm
                action={setAiSystemStatusAction.bind(
                  null,
                  access.organizationId,
                  aiSystem.id,
                  archived ? "active" : "archived",
                )}
                label={archived ? "Restore this system" : "Archive this system"}
                pendingLabel={archived ? "Restoring…" : "Archiving…"}
                explanation={
                  archived
                    ? "Restoring makes it active again. Its name must not be in use by another active system."
                    : "Archiving hides it from the active list. Nothing is deleted, and you can restore it at any time."
                }
              />
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

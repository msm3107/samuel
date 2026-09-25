import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { AiSystemForm } from "@/components/dashboard/ai-system-form";
import { AiSystemStatusForm } from "@/components/dashboard/ai-system-status-form";
import { Breadcrumbs } from "@/components/dashboard/breadcrumbs";
import { DeploymentForm } from "@/components/dashboard/deployment-form";
import { Hostname } from "@/components/dashboard/hostname";
import { TEXT_LINK } from "@/components/ui/styles";
import {
  formValuesOf,
  SYSTEM_TYPE_LABELS,
} from "@/features/ai-systems/ai-system-form";
import { readAiSystem } from "@/features/ai-systems/ai-system-queries";
import type { SerializedDeployment } from "@/features/deployments/deployment";
import { DEPLOYMENT_STATUS_LABELS } from "@/features/deployments/deployment-fields";
import {
  DEPLOYMENT_LIST_LIMIT,
  listDeployments,
} from "@/features/deployments/deployment-queries";
import { minimumRoleFor, roleSatisfies } from "@/lib/auth/organization-roles";

import {
  organizationAccessOrNotFound,
  organizationOrNotFound,
} from "../../access";
import { createDeploymentAction } from "../../deployments/actions";
import { deploymentPath } from "../../deployments/messages";
import { setAiSystemStatusAction, updateAiSystemAction } from "../actions";
import { systemsPath } from "../messages";
import { disclosurePath } from "./disclosure/messages";

const systemIdSchema = z.uuid();

/**
 * One AI system (TASK-010). Viewers read it; members also edit, archive and
 * restore it here. A system this organization does not have, including
 * another organization's, is not found, and a non-UUID is too, without a
 * query.
 *
 * Its deployments are listed here, and registered here (TASK-015; owner,
 * 2026-09-22): a deployment always belongs to one system.
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
  // Active and archived deployments separately, so a long list of one
  // can't push the other out.
  const [organization, aiSystem, active, archivedDeployments] =
    await Promise.all([
      organizationOrNotFound(access),
      readAiSystem(access, id.data),
      listDeployments(access, "active", id.data),
      listDeployments(access, "archived", id.data),
    ]);
  if (aiSystem === null) {
    notFound();
  }
  const canManage = roleSatisfies(
    access.role,
    minimumRoleFor("systems.manage"),
  );
  const archived = aiSystem.status === "archived";
  const canManageDeployments = roleSatisfies(
    access.role,
    minimumRoleFor("deployments.manage"),
  );
  const deployments = [
    ...active.deployments,
    ...archivedDeployments.deployments,
  ];

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

      <section className="mt-12" aria-labelledby="disclosure-heading">
        <h2 id="disclosure-heading" className="text-xl font-semibold">
          Disclosure
        </h2>
        <p className="mt-4 text-slate-700">
          <Link
            href={disclosurePath(access.organizationId, aiSystem.id)}
            className={TEXT_LINK}
          >
            The transparency notice
          </Link>{" "}
          this system shows, and every version published so far.
        </p>
      </section>

      <section className="mt-12" aria-labelledby="deployments-heading">
        <h2 id="deployments-heading" className="text-xl font-semibold">
          Deployments
        </h2>
        {archived && active.deployments.length > 0 ? (
          <p role="note" className="mt-4 text-sm text-slate-700">
            This system is archived, so its deployments are inactive: the widget
            and the checks ignore them until the system is restored.
          </p>
        ) : null}
        {deployments.length === 0 ? (
          <p className="mt-4 text-slate-700">No hostnames registered yet.</p>
        ) : (
          <DeploymentTable
            organizationId={access.organizationId}
            deployments={deployments}
            systemArchived={archived}
          />
        )}
        {active.truncated || archivedDeployments.truncated ? (
          <p role="note" className="mt-4 text-sm text-slate-700">
            Showing the first {DEPLOYMENT_LIST_LIMIT} active and the first{" "}
            {DEPLOYMENT_LIST_LIMIT} archived deployments, by hostname.
          </p>
        ) : null}

        {canManageDeployments ? (
          <div className="mt-8">
            <h3 className="text-lg font-semibold">Register a hostname</h3>
            {archived ? (
              // No dead control: the database refuses this anyway.
              <p className="mt-2 text-sm text-slate-700">
                This system is archived. Restore it to register hostnames.
              </p>
            ) : (
              <DeploymentForm
                action={createDeploymentAction.bind(
                  null,
                  access.organizationId,
                  aiSystem.id,
                )}
              />
            )}
          </div>
        ) : null}
      </section>

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

/**
 * The system's deployments, active first, each by hostname (TASK-015). Under
 * an archived system an active deployment is marked inactive, because the
 * widget and the checks ignore it (PR #25 review, finding 2).
 */
function DeploymentTable({
  organizationId,
  deployments,
  systemArchived,
}: {
  organizationId: string;
  deployments: readonly SerializedDeployment[];
  systemArchived: boolean;
}) {
  return (
    <table className="mt-4 w-full border-collapse text-left">
      <caption className="sr-only">Deployments of this system</caption>
      <thead>
        <tr className="border-b border-slate-300 text-sm text-slate-700">
          <th scope="col" className="py-2 pr-4 font-medium">
            Hostname
          </th>
          <th scope="col" className="py-2 font-medium">
            Status
          </th>
        </tr>
      </thead>
      <tbody>
        {deployments.map((deployment) => (
          <tr key={deployment.id} className="border-b border-slate-200">
            <td className="py-3 pr-4 break-all">
              <Link
                href={deploymentPath(organizationId, deployment.id)}
                className={TEXT_LINK}
              >
                <Hostname
                  hostname={deployment.hostname}
                  unicodeHostname={deployment.unicodeHostname}
                />
              </Link>
            </td>
            <td className="py-3">
              {DEPLOYMENT_STATUS_LABELS[deployment.status]}
              {systemArchived && deployment.status === "active"
                ? " (inactive)"
                : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { Breadcrumbs } from "@/components/dashboard/breadcrumbs";
import { DeploymentStatusForm } from "@/components/dashboard/deployment-status-form";
import { Hostname } from "@/components/dashboard/hostname";
import { InstallInstructions } from "@/components/dashboard/install-instructions";
import { TEXT_LINK } from "@/components/ui/styles";
import { readAiSystem } from "@/features/ai-systems/ai-system-queries";
import { DEPLOYMENT_STATUS_LABELS } from "@/features/deployments/deployment-fields";
import { readDeployment } from "@/features/deployments/deployment-queries";
import {
  installReadiness,
  type InstallReadinessState,
} from "@/features/deployments/install-readiness";
import { readCurrentDisclosureState } from "@/features/disclosures/disclosure-queries";
import { minimumRoleFor, roleSatisfies } from "@/lib/auth/organization-roles";
import { serverEnv } from "@/lib/env/server-env";

import {
  organizationAccessOrNotFound,
  organizationOrNotFound,
} from "../../access";
import { disclosurePath } from "../../systems/[systemId]/disclosure/messages";
import { systemPath, systemsPath } from "../../systems/messages";
import { setDeploymentStatusAction } from "../actions";

const deploymentIdSchema = z.uuid();

/**
 * Where the installation section sends somebody whose tag would render
 * nothing (TASK-021). Fixed text and a fixed destination per state, like
 * every other message on these screens. `deployment_archived` has none:
 * restoring it is the control further down this same page, and `live`
 * needs no fixing.
 */
const FIXES: Partial<
  Record<InstallReadinessState, { to: "system" | "disclosure"; label: string }>
> = {
  system_archived: { to: "system", label: "Open the AI system" },
  never_published: { to: "disclosure", label: "Publish a notice" },
  disabled: { to: "disclosure", label: "Open the notice" },
};

/** Always in UTC, said as such: the server doesn't know the reader's zone. */
const REGISTERED_AT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});

/**
 * One deployment (TASK-015). Viewers read it; members also archive and
 * restore it here. A deployment this organization does not have, including
 * another organization's, is not found, and a non-UUID is too, without a
 * query.
 */
export default async function DeploymentPage({
  params,
}: {
  params: Promise<{ organizationId: string; deploymentId: string }>;
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
  const [organization, deployment] = await Promise.all([
    organizationOrNotFound(access),
    readDeployment(access, id.data),
  ]);
  if (deployment === null) {
    notFound();
  }
  // The system's name, for the heading's trail and the link back, and the
  // current version of its notice, for whether an installed tag would show
  // anything (TASK-021). The same organization's, through the same
  // row-level security; the system is gone only if it was deleted since,
  // which is then not found like the deployment.
  const [aiSystem, currentDisclosure] = await Promise.all([
    readAiSystem(access, deployment.aiSystemId),
    readCurrentDisclosureState(access, deployment.aiSystemId),
  ]);
  if (aiSystem === null) {
    notFound();
  }
  const canManage = roleSatisfies(
    access.role,
    minimumRoleFor("deployments.manage"),
  );
  const archived = deployment.status === "archived";
  const systemArchived = deployment.aiSystemStatus === "archived";
  const toSystem = systemPath(access.organizationId, aiSystem.id);
  const toDisclosure = disclosurePath(access.organizationId, aiSystem.id);
  const readiness = installReadiness({
    deploymentStatus: deployment.status,
    aiSystemStatus: deployment.aiSystemStatus,
    current: currentDisclosure,
  });
  // Where to go to make the tag render, when it would not today. An
  // archived deployment has no link: the control for it is on this page.
  const fix = FIXES[readiness.state];

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-12">
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: organization.name },
          { label: "AI systems", href: systemsPath(access.organizationId) },
          { label: aiSystem.name, href: toSystem },
          // The ASCII form: a crumb is isolated with `dir="auto"`, which a
          // hostname must never get, and ASCII reads left to right anyway.
          { label: deployment.hostname },
        ]}
      />
      <h1 className="mt-6 text-3xl font-semibold tracking-tight break-words">
        <Hostname
          hostname={deployment.hostname}
          unicodeHostname={deployment.unicodeHostname}
        />
      </h1>

      <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3">
        <dt className="font-medium">Status</dt>
        <dd>
          {DEPLOYMENT_STATUS_LABELS[deployment.status]}
          {systemArchived && !archived ? (
            <p className="text-sm text-slate-700">
              Inactive: its AI system is archived, so the widget and the checks
              ignore it until the system is restored.
            </p>
          ) : null}
        </dd>
        <dt className="font-medium">AI system</dt>
        <dd>
          <Link href={toSystem} className={TEXT_LINK}>
            <bdi>{aiSystem.name}</bdi>
          </Link>
          {systemArchived ? " (archived)" : null}
        </dd>
        <dt className="font-medium">Public ID</dt>
        <dd>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 select-all">
            {deployment.publicId}
          </code>
          <p className="mt-1 text-sm text-slate-700">
            What names this deployment in the install code below. It is public,
            and grants no access.
          </p>
        </dd>
        <dt className="font-medium">Registered</dt>
        <dd>
          <time dateTime={deployment.createdAt}>
            {REGISTERED_AT.format(new Date(deployment.createdAt))} UTC
          </time>
        </dd>
      </dl>

      <InstallInstructions
        publicId={deployment.publicId}
        appUrl={serverEnv().NEXT_PUBLIC_APP_URL}
        readiness={readiness}
        fix={
          fix === undefined
            ? undefined
            : {
                href: fix.to === "system" ? toSystem : toDisclosure,
                label: fix.label,
              }
        }
      />

      {canManage ? (
        <section className="mt-12" aria-labelledby="status-heading">
          <h2 id="status-heading" className="text-xl font-semibold">
            {archived ? "Restore" : "Archive"}
          </h2>
          <div className="mt-4">
            {/* One form whichever way it goes, so the result it announces
                survives the page re-rendering with the new status. */}
            <DeploymentStatusForm
              action={setDeploymentStatusAction.bind(
                null,
                access.organizationId,
                deployment.id,
                archived ? "active" : "archived",
              )}
              label={
                archived ? "Restore this deployment" : "Archive this deployment"
              }
              pendingLabel={archived ? "Restoring…" : "Archiving…"}
              explanation={
                archived
                  ? "Restoring makes it active again with the same public ID, so a widget still naming it works again. For a new ID, register the hostname again instead; the new deployment starts with no check history."
                  : "Archiving switches it off: its public ID stops working and it is no longer checked. Nothing is deleted. Restoring brings the same ID back; for a new one, archive it and register the hostname again, which starts with no check history."
              }
              // No dead control: the database refuses this restore anyway.
              unavailable={
                archived && systemArchived
                  ? "Its AI system is archived. Restore the system first, then this deployment."
                  : undefined
              }
            />
          </div>
        </section>
      ) : null}
    </main>
  );
}

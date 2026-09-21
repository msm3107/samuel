import { AiSystemForm } from "@/components/dashboard/ai-system-form";
import { Breadcrumbs } from "@/components/dashboard/breadcrumbs";
import { readOrganization } from "@/features/organizations/organization-queries";

import { organizationAccessOrNotFound } from "../../access";
import { createAiSystemAction } from "../actions";
import { systemsPath } from "../messages";

const BLANK = { name: "", systemType: "", provider: "", description: "" };

/**
 * Registers an AI system (TASK-010). Members and up: a viewer gets the
 * not-found page, as for an organization they are not in. The action checks
 * again, so hiding this page is not what stops a viewer.
 */
export default async function NewAiSystemPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const access = await organizationAccessOrNotFound(
    organizationId,
    "systems.manage",
  );
  const organization = await readOrganization(access);

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-12">
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: organization.name },
          { label: "AI systems", href: systemsPath(access.organizationId) },
          { label: "Register" },
        ]}
      />
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">
        Register an AI system
      </h1>
      <AiSystemForm
        action={createAiSystemAction.bind(null, access.organizationId)}
        initialValues={BLANK}
        submitLabel="Register"
        pendingLabel="Registering…"
      />
    </main>
  );
}

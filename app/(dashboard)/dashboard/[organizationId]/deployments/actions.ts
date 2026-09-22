"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { DEPLOYMENT_STATUSES } from "@/features/deployments/deployment";
import { parseDeploymentForm } from "@/features/deployments/deployment-form";
import {
  createDeployment,
  updateDeployment,
} from "@/features/deployments/deployment-queries";
import { AuthorizationError } from "@/lib/auth/errors";

import { organizationAccessOrNull } from "../access";
import { systemPath } from "../systems/messages";
import {
  deploymentPath,
  type DeploymentFormState,
  type DeploymentStatusState,
} from "./messages";

/**
 * The deployment forms' server actions (TASK-015). Next.js refuses an
 * action whose Origin does not match the host, which is its CSRF protection.
 *
 * The organization, AI system, deployment and status are bound into each
 * action by the page, but bound arguments come back from the browser like
 * any other request data, so none is trusted: each action authenticates,
 * authorizes the organization, and validates the rest, as the API routes
 * do. Every query then uses the authorized `access.organizationId`, not the
 * argument.
 */

const idSchema = z.uuid();
const statusSchema = z.enum(DEPLOYMENT_STATUSES);

/**
 * Registers a hostname under an AI system, then opens the new deployment,
 * where its public ID is.
 */
export async function createDeploymentAction(
  organizationId: string,
  aiSystemId: string,
  _previous: DeploymentFormState,
  formData: FormData,
): Promise<DeploymentFormState> {
  const access = await organizationAccessOrNull(
    organizationId,
    "deployments.manage",
  );
  // Authorized before the form is read, as the API routes check permission
  // before reading the body (PR #29 review, note 2). A refused caller gets
  // nothing back, not even what they typed.
  if (access === null) {
    return { result: "not_permitted", value: "" };
  }
  const form = parseDeploymentForm(formData);
  const systemId = idSchema.safeParse(aiSystemId);
  if (!systemId.success) {
    return { result: "ai_system_not_found", value: form.value };
  }
  if (!form.success) {
    return { result: form.code, value: form.value };
  }

  const result = await refusedAsNotPermitted(() =>
    createDeployment(access, {
      aiSystemId: systemId.data,
      hostname: form.hostname,
    }),
  );
  if (result.status !== "ok") {
    return { result: result.status, value: form.value };
  }

  refreshScreens(access.organizationId, result.deployment);
  redirect(deploymentPath(access.organizationId, result.deployment.id));
}

/**
 * Archives a deployment, or restores an archived one. Restoring brings its
 * old public ID back (PR #28 review, note 1).
 */
export async function setDeploymentStatusAction(
  organizationId: string,
  deploymentId: string,
  status: string,
  _previous: DeploymentStatusState,
  _formData: FormData,
): Promise<DeploymentStatusState> {
  const access = await organizationAccessOrNull(
    organizationId,
    "deployments.manage",
  );
  if (access === null) {
    return { result: "not_permitted" };
  }
  const id = idSchema.safeParse(deploymentId);
  if (!id.success) {
    return { result: "not_found" };
  }
  const target = statusSchema.safeParse(status);
  if (!target.success) {
    return { result: "invalid" };
  }

  const result = await refusedAsNotPermitted(() =>
    updateDeployment(access, id.data, { status: target.data }),
  );
  if (result.status !== "ok") {
    return { result: result.status };
  }

  refreshScreens(access.organizationId, result.deployment);
  return { result: target.data === "archived" ? "archived" : "restored" };
}

/**
 * The deployment's page and its system's page show the change on their
 * next view. The system is the one the database returned, not one bound
 * into the action.
 */
function refreshScreens(
  organizationId: string,
  deployment: { id: string; aiSystemId: string },
): void {
  revalidatePath(deploymentPath(organizationId, deployment.id));
  revalidatePath(systemPath(organizationId, deployment.aiSystemId));
}

/**
 * A role lowered or removed after the check, which RLS refuses on an insert
 * (`42501`), answered in the form like any other refusal. Every other error
 * is thrown, and renders as an error page with a reference.
 */
async function refusedAsNotPermitted<T>(
  write: () => Promise<T>,
): Promise<T | { status: "not_permitted" }> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "not_permitted" };
    }
    throw error;
  }
}

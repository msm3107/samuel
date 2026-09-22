import { z } from "zod";

import { updateDeploymentSchema } from "@/features/deployments/deployment";
import {
  readDeployment,
  updateDeployment,
} from "@/features/deployments/deployment-queries";
import { requireOrganizationPermission } from "@/lib/auth/require-organization-role";
import {
  ApiRequestError,
  assertSameOrigin,
  handleApiRequest,
  jsonResponse,
  readJsonBody,
} from "@/lib/http/api";

type RouteContext = {
  params: Promise<{ organizationId: string; deploymentId: string }>;
};

const deploymentIdSchema = z.uuid();

/**
 * A deployment ID that is not a UUID names no deployment: the same 404 as
 * one this organization does not have, and no query is made for it.
 */
function parseDeploymentId(deploymentId: string): string {
  const parsed = deploymentIdSchema.safeParse(deploymentId);
  if (!parsed.success) {
    throw notFound();
  }
  return parsed.data;
}

function notFound() {
  return new ApiRequestError(404, "deployment_not_found");
}

/** One deployment of the organization. */
export async function GET(_request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "GET /api/organizations/[id]/deployments/[id]",
    async () => {
      const { organizationId, deploymentId } = await params;
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "organization.read",
      });
      const deployment = await readDeployment(
        access,
        parseDeploymentId(deploymentId),
      );
      if (deployment === null) {
        throw notFound();
      }
      return jsonResponse({ deployment });
    },
  );
}

/** Archives or restores a deployment. Members and up. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "PATCH /api/organizations/[id]/deployments/[id]",
    async () => {
      assertSameOrigin(request);
      const { organizationId, deploymentId } = await params;
      // The organization first, so a non-member learns nothing about which
      // deployment IDs exist, or how their body would have been validated.
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "deployments.manage",
      });
      const id = parseDeploymentId(deploymentId);
      const change = await readJsonBody(request, updateDeploymentSchema);
      const result = await updateDeployment(access, id, change);
      switch (result.status) {
        case "ok":
          return jsonResponse({ deployment: result.deployment });
        case "not_found":
          throw notFound();
        // Restoring: the hostname is active again on the same system.
        case "exists":
          throw new ApiRequestError(409, "deployment_exists");
        // Restoring under an archived system.
        case "ai_system_archived":
          throw new ApiRequestError(409, "ai_system_archived");
      }
    },
  );
}

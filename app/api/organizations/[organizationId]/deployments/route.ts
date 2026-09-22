import { z } from "zod";

import {
  createDeploymentSchema,
  deploymentListFilterSchema,
  HOSTNAME_ERROR_CODES,
} from "@/features/deployments/deployment";
import {
  createDeployment,
  listDeployments,
} from "@/features/deployments/deployment-queries";
import { requireOrganizationPermission } from "@/lib/auth/require-organization-role";
import {
  ApiRequestError,
  assertSameOrigin,
  handleApiRequest,
  jsonResponse,
  readJsonBody,
} from "@/lib/http/api";
import { validateVerificationTarget } from "@/lib/security/verification-target";

type RouteContext = { params: Promise<{ organizationId: string }> };

/**
 * The organization's deployments: `?status=active` (default), `archived` or
 * `all`, and optionally `?aiSystemId=` for one system's.
 */
export async function GET(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "GET /api/organizations/[id]/deployments",
    async () => {
      const { organizationId } = await params;
      // Authenticate and authorize before the query string is looked at.
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "organization.read",
      });
      const searchParams = new URL(request.url).searchParams;
      const filter = parseSingle(
        searchParams,
        "status",
        deploymentListFilterSchema,
      );
      const aiSystemId =
        parseSingle(searchParams, "aiSystemId", z.uuid().optional()) ?? null;
      const { deployments, truncated } = await listDeployments(
        access,
        filter,
        aiSystemId,
      );
      return jsonResponse({ deployments, truncated });
    },
  );
}

/** Registers where an AI system is deployed. Members and up. */
export async function POST(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "POST /api/organizations/[id]/deployments",
    async () => {
      assertSameOrigin(request);
      const { organizationId } = await params;
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "deployments.manage",
      });
      const input = await readJsonBody(request, createDeploymentSchema);
      // The one check on where the verifier may go (TASK-012). Its output
      // is the only hostname ever stored.
      const target = validateVerificationTarget(input.hostname);
      if (!target.ok) {
        throw new ApiRequestError(400, HOSTNAME_ERROR_CODES[target.code]);
      }
      const result = await createDeployment(access, {
        aiSystemId: input.aiSystemId,
        hostname: target.hostname,
      });
      switch (result.status) {
        case "ok":
          return jsonResponse({ deployment: result.deployment }, 201);
        case "exists":
          throw new ApiRequestError(409, "deployment_exists");
        case "ai_system_archived":
          throw new ApiRequestError(409, "ai_system_archived");
        case "ai_system_not_found":
          throw new ApiRequestError(404, "ai_system_not_found");
      }
    },
  );
}

/**
 * One value for a query parameter, or none. A repeated parameter is
 * ambiguous and refused, as on the AI systems list.
 */
function parseSingle<Schema extends z.ZodType>(
  searchParams: URLSearchParams,
  name: string,
  schema: Schema,
): z.infer<Schema> {
  const values = searchParams.getAll(name);
  if (values.length > 1) {
    throw new ApiRequestError(400, "invalid_request");
  }
  const parsed = schema.safeParse(values[0]);
  if (!parsed.success) {
    throw new ApiRequestError(400, "invalid_request");
  }
  return parsed.data;
}

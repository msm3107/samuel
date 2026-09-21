import {
  aiSystemListFilterSchema,
  createAiSystemSchema,
} from "@/features/ai-systems/ai-system";
import {
  createAiSystem,
  listAiSystems,
} from "@/features/ai-systems/ai-system-queries";
import { requireOrganizationPermission } from "@/lib/auth/require-organization-role";
import {
  ApiRequestError,
  assertSameOrigin,
  handleApiRequest,
  jsonResponse,
  readJsonBody,
} from "@/lib/http/api";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** The organization's AI systems: `?status=active` (default), `archived` or `all`. */
export async function GET(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "GET /api/organizations/[id]/ai-systems",
    async () => {
      const { organizationId } = await params;
      // Authenticate and authorize before the query string is looked at.
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "organization.read",
      });
      const filter = parseStatusFilter(request);
      const { aiSystems, truncated } = await listAiSystems(access, filter);
      return jsonResponse({ aiSystems, truncated });
    },
  );
}

/** Registers a system in the organization. Members and up. */
export async function POST(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "POST /api/organizations/[id]/ai-systems",
    async () => {
      assertSameOrigin(request);
      const { organizationId } = await params;
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "systems.manage",
      });
      const input = await readJsonBody(request, createAiSystemSchema);
      const result = await createAiSystem(access, input);
      if (result.status === "name_taken") {
        throw new ApiRequestError(409, "ai_system_name_taken");
      }
      return jsonResponse({ aiSystem: result.aiSystem }, 201);
    },
  );
}

/**
 * One `status` value, or none. A repeated parameter is ambiguous and
 * refused, as in the sign-in callback.
 */
function parseStatusFilter(request: Request) {
  const values = new URL(request.url).searchParams.getAll("status");
  if (values.length > 1) {
    throw new ApiRequestError(400, "invalid_request");
  }
  const parsed = aiSystemListFilterSchema.safeParse(values[0]);
  if (!parsed.success) {
    throw new ApiRequestError(400, "invalid_request");
  }
  return parsed.data;
}

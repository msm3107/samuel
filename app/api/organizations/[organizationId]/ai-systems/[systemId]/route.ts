import { z } from "zod";

import { updateAiSystemSchema } from "@/features/ai-systems/ai-system";
import {
  readAiSystem,
  updateAiSystem,
} from "@/features/ai-systems/ai-system-queries";
import { requireOrganizationPermission } from "@/lib/auth/require-organization-role";
import {
  ApiRequestError,
  assertSameOrigin,
  handleApiRequest,
  jsonResponse,
  readJsonBody,
} from "@/lib/http/api";

type RouteContext = {
  params: Promise<{ organizationId: string; systemId: string }>;
};

const systemIdSchema = z.uuid();

/**
 * A system ID that is not a UUID names no system: the same 404 as one this
 * organization does not have, and no query is made for it.
 */
function parseSystemId(systemId: string): string {
  const parsed = systemIdSchema.safeParse(systemId);
  if (!parsed.success) {
    throw notFound();
  }
  return parsed.data;
}

function notFound() {
  return new ApiRequestError(404, "ai_system_not_found");
}

/** One system of the organization. */
export async function GET(_request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "GET /api/organizations/[id]/ai-systems/[id]",
    async () => {
      const { organizationId, systemId } = await params;
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "organization.read",
      });
      const aiSystem = await readAiSystem(access, parseSystemId(systemId));
      if (aiSystem === null) {
        throw notFound();
      }
      return jsonResponse({ aiSystem });
    },
  );
}

/** Edits, archives or un-archives a system. Members and up. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "PATCH /api/organizations/[id]/ai-systems/[id]",
    async () => {
      assertSameOrigin(request);
      const { organizationId, systemId } = await params;
      // The organization first, so a non-member learns nothing about which
      // system IDs exist, or how their body would have been validated.
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "systems.manage",
      });
      const id = parseSystemId(systemId);
      const change = await readJsonBody(request, updateAiSystemSchema);
      const result = await updateAiSystem(access, id, change);
      if (result.status === "not_found") {
        throw notFound();
      }
      if (result.status === "name_taken") {
        throw new ApiRequestError(409, "ai_system_name_taken");
      }
      return jsonResponse({ aiSystem: result.aiSystem });
    },
  );
}

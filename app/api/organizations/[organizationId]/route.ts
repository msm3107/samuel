import { z } from "zod";

import { organizationNameSchema } from "@/features/organizations/organization";
import {
  readOrganization,
  renameOrganization,
} from "@/features/organizations/organization-queries";
import { requireOrganizationPermission } from "@/lib/auth/require-organization-role";
import {
  assertSameOrigin,
  handleApiRequest,
  jsonResponse,
  readJsonBody,
} from "@/lib/http/api";

type RouteContext = { params: Promise<{ organizationId: string }> };

/** Only the name can change here; the slug is fixed at creation. */
const renameOrganizationBody = z.strictObject({ name: organizationNameSchema });

/**
 * One organization the signed-in user belongs to. An organization that does
 * not exist, was deleted, or belongs to someone else is the same 403.
 */
export async function GET(_request: Request, { params }: RouteContext) {
  return handleApiRequest("GET /api/organizations/[id]", async () => {
    const { organizationId } = await params;
    // Authenticate and authorize: the session, then the membership, read
    // afresh. The ID from the URL only names what is asked about.
    const access = await requireOrganizationPermission({
      organizationId,
      permission: "organization.read",
    });
    const organization = await readOrganization(access);
    return jsonResponse({ organization });
  });
}

/** Renames an organization. Owners and admins. */
export async function PATCH(request: Request, { params }: RouteContext) {
  return handleApiRequest("PATCH /api/organizations/[id]", async () => {
    assertSameOrigin(request);
    const { organizationId } = await params;
    // Authenticate and authorize before the body is read, so a non-member
    // learns nothing from how their body would have been validated.
    const access = await requireOrganizationPermission({
      organizationId,
      permission: "organization.update",
    });
    const { name } = await readJsonBody(request, renameOrganizationBody);
    const organization = await renameOrganization(access, name);
    return jsonResponse({ organization });
  });
}

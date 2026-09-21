import { z } from "zod";

import { createOrganization } from "@/features/organizations/create-organization";
import { organizationNameSchema } from "@/features/organizations/organization";
import { listOrganizations } from "@/features/organizations/organization-queries";
import { requireSession } from "@/lib/auth/require-session";
import {
  ApiRequestError,
  assertSameOrigin,
  handleApiRequest,
  jsonResponse,
  readJsonBody,
} from "@/lib/http/api";

/**
 * A name and nothing else. Strict, so a body that also carries `userId`,
 * `role`, `organizationId` or `slug` is refused rather than silently
 * ignored: none of them is ever the client's to choose.
 */
const createOrganizationBody = z.strictObject({ name: organizationNameSchema });

/** The signed-in user's organizations. */
export async function GET() {
  return handleApiRequest("GET /api/organizations", async () => {
    // Authenticate. Authorization is row-level security: the query returns
    // only organizations the user belongs to.
    await requireSession();
    const organizations = await listOrganizations();
    return jsonResponse({ organizations });
  });
}

/** Creates an organization owned by the signed-in user. */
export async function POST(request: Request) {
  return handleApiRequest("POST /api/organizations", async () => {
    // Cross-site requests are refused before anything else, so a forged
    // request costs no auth-server call.
    assertSameOrigin(request);
    // Authenticate. Authorize: any signed-in user may create an
    // organization, up to the database's hourly cap.
    await requireSession();
    // Validate.
    const { name } = await readJsonBody(request, createOrganizationBody);
    // Execute.
    const result = await createOrganization(name);
    if (result.status === "limited") {
      throw new ApiRequestError(429, "organization_limit_reached");
    }
    // Serialize: already reduced to id, name and slug.
    return jsonResponse({ organization: result.organization }, 201);
  });
}

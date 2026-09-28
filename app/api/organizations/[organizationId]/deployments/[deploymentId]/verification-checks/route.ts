import { z } from "zod";

import { verificationCursorSchema } from "@/features/verification/verification-check";
import { listVerificationChecks } from "@/features/verification/verification-history-queries";
import { requireOrganizationPermission } from "@/lib/auth/require-organization-role";
import {
  ApiRequestError,
  handleApiRequest,
  jsonResponse,
} from "@/lib/http/api";

type RouteContext = {
  params: Promise<{ organizationId: string; deploymentId: string }>;
};

const ROUTE =
  "GET /api/organizations/[id]/deployments/[id]/verification-checks";

const deploymentIdSchema = z.uuid();

/**
 * One deployment's verification history (TASK-026; README §18-§20, §31).
 *
 * Read-only, and there is no other verb here: a verification check is
 * append-only evidence, so no route offers an update or a delete of one, and
 * the table grants neither to any role in the first place.
 *
 * Paged newest first, at most 200 checks. `truncated: true` means more exist
 * below the last one; ask again with that row's `checkWindow` as `before`.
 * §31 documents the rule for both paged endpoints.
 *
 * The organization and the deployment come from the path. The only value read
 * from the query string is the cursor, which names no resource — so there is
 * nothing here a caller could substitute to reach another tenant's evidence.
 */
export async function GET(request: Request, { params }: RouteContext) {
  return handleApiRequest(ROUTE, async () => {
    const { organizationId, deploymentId } = await params;

    // Authenticate and authorize before anything is parsed or read: a caller
    // without a role in this organization learns nothing, not even whether
    // their cursor was well formed.
    const access = await requireOrganizationPermission({
      organizationId,
      permission: "organization.read",
    });

    // A deployment ID that is not a UUID names no deployment: the same 404 as
    // one this organization does not have, and no query is made for it.
    const parsedId = deploymentIdSchema.safeParse(deploymentId);
    if (!parsedId.success) {
      throw notFound();
    }

    const history = await listVerificationChecks(
      access,
      parsedId.data,
      readCursor(request),
    );
    // Null is "no such deployment in this organization", which includes another
    // organization's — so this 404 says nothing about whether it exists.
    if (history === null) {
      throw notFound();
    }
    return jsonResponse(history);
  });
}

function notFound() {
  return new ApiRequestError(404, "deployment_not_found");
}

/**
 * The page to read. A malformed cursor is refused rather than treated as
 * absent: answering with the newest checks would silently ignore what the
 * caller asked for, and answering with an empty page would hide their bug. A
 * *valid* timestamp older than every row is an empty page, which is true.
 *
 * A repeated `before` is refused too, as on the disclosures and the
 * deployments lists (PR #43 review, note 2). Two cursors name two different
 * pages and there is nothing to prefer between them, so guessing the first
 * would answer a question the caller did not ask.
 */
function readCursor(request: Request): { before?: Date } {
  const values = new URL(request.url).searchParams.getAll("before");
  if (values.length === 0) {
    return {};
  }
  if (values.length > 1) {
    throw new ApiRequestError(400, "invalid_cursor");
  }
  const parsed = verificationCursorSchema.safeParse(values[0]);
  if (!parsed.success) {
    throw new ApiRequestError(400, "invalid_cursor");
  }
  return { before: parsed.data };
}

import { z } from "zod";

import {
  disclosureCursorSchema,
  publishDisclosureSchema,
} from "@/features/disclosures/disclosure";
import {
  listDisclosures,
  publishDisclosure,
} from "@/features/disclosures/disclosure-queries";
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

/**
 * An AI system's disclosure versions, newest first: the first is the one
 * its widget shows (TASK-016: one history per system).
 *
 * `before` reads an older page (TASK-018a), exclusive, so passing the last
 * version of a page gives the next one. Absent means the newest. A `before`
 * that is not a version number is refused here rather than ignored: a
 * client asked for something exact and is told it could not be given.
 */
export async function GET(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "GET /api/organizations/[id]/ai-systems/[id]/disclosures",
    async () => {
      const { organizationId, systemId } = await params;
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "organization.read",
      });
      const before = parseCursor(new URL(request.url).searchParams);
      const history = await listDisclosures(access, parseSystemId(systemId), {
        before,
      });
      if (history === null) {
        throw notFound();
      }
      return jsonResponse(history);
    },
  );
}

/**
 * The `before` cursor, or none. A repeated parameter is ambiguous and
 * refused, as on the deployments list.
 */
function parseCursor(searchParams: URLSearchParams): number | undefined {
  const values = searchParams.getAll("before");
  if (values.length === 0) {
    return undefined;
  }
  if (values.length > 1) {
    throw new ApiRequestError(400, "invalid_request");
  }
  const parsed = disclosureCursorSchema.safeParse(values[0]);
  if (!parsed.success) {
    throw new ApiRequestError(400, "invalid_request");
  }
  return parsed.data;
}

/**
 * Publishes a new version. Members and up. A publish based on an older
 * version than the current one, or identical to it, is refused (owner's
 * decisions, 2026-09-22).
 */
export async function POST(request: Request, { params }: RouteContext) {
  return handleApiRequest(
    "POST /api/organizations/[id]/ai-systems/[id]/disclosures",
    async () => {
      assertSameOrigin(request);
      const { organizationId, systemId } = await params;
      const access = await requireOrganizationPermission({
        organizationId,
        permission: "disclosures.manage",
      });
      const aiSystemId = parseSystemId(systemId);
      const input = await readJsonBody(request, publishDisclosureSchema);
      const result = await publishDisclosure(access, aiSystemId, input);
      switch (result.status) {
        case "ok":
          return jsonResponse({ disclosure: result.disclosure }, 201);
        case "disclosure_changed":
          throw new ApiRequestError(409, "disclosure_changed");
        case "disclosure_unchanged":
          throw new ApiRequestError(409, "disclosure_unchanged");
        case "ai_system_archived":
          throw new ApiRequestError(409, "ai_system_archived");
        case "ai_system_not_found":
          throw notFound();
      }
    },
  );
}

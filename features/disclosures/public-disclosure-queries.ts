import "server-only";

import { createPublicClient } from "@/lib/database/public-client";

import {
  publicDisclosureRowsSchema,
  type PublicDisclosure,
} from "./public-disclosure";

/**
 * The public lookup (TASK-019a): one call to `public.public_disclosure`,
 * with the anon key and no session.
 *
 * The rules about which deployments resolve are the function's, not this
 * module's (TASK-019, owner 2026-09-25): active deployment, active system,
 * live organization, current version, enabled. Nothing is filtered again
 * here, so there is one place to read and one place to change.
 */

/**
 * The database refused in a way no validated request should cause. Marked
 * `unavailable`, so the route answers `503` and the widget may try again:
 * the lookup and the rate limiter are the same database, and neither
 * failing is the caller's doing.
 */
export class PublicDisclosureQueryError extends Error {
  override readonly name = "PublicDisclosureQueryError";
  readonly unavailable = true;

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("The public disclosure could not be read", options);
  }
}

/**
 * The function answered something this application cannot read: a column
 * added to its return type, a language the table should not hold, more
 * than one row. Not marked `unavailable` — retrying will not help, and it
 * is a fault of ours rather than an outage.
 */
export class PublicDisclosureShapeError extends Error {
  override readonly name = "PublicDisclosureShapeError";

  constructor(options?: ErrorOptions) {
    super(
      "The public lookup answered a shape this application cannot send",
      options,
    );
  }
}

/**
 * The notice an active deployment should show, or null when there is
 * nothing to show — which the function answers identically for all six
 * causes, so nothing here can tell them apart either.
 *
 * `publicId` has already passed `isPublicDeploymentId`; it is still sent as
 * a bound parameter, never interpolated.
 */
export async function lookupPublicDisclosure(
  publicId: string,
): Promise<PublicDisclosure | null> {
  const { data, error } = await createPublicClient().rpc("public_disclosure", {
    p_public_id: publicId,
  });

  if (error) {
    throw new PublicDisclosureQueryError(error.code, { cause: error });
  }

  // Validated rather than trusted: the response is built from the parsed
  // row, so a column added to the function's return type is a failure here
  // and never a field on the wire.
  const rows = publicDisclosureRowsSchema.safeParse(data);
  if (!rows.success) {
    throw new PublicDisclosureShapeError({ cause: rows.error });
  }
  return rows.data[0] ?? null;
}

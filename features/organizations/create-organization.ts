import "server-only";

import { createResolvingSessionClient } from "@/lib/database/session-client";

import {
  serializeOrganization,
  type OrganizationName,
  type SerializedOrganization,
} from "./organization";

export type CreateOrganizationResult =
  | { status: "created"; organization: SerializedOrganization }
  /** The creator's 10-an-hour cap, decided by the database. */
  | { status: "limited" };

/** The database refused in a way no validated request should cause. */
export class OrganizationCreationError extends Error {
  override readonly name = "OrganizationCreationError";

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("The organization could not be created", options);
  }
}

/**
 * Creates an organization owned by the signed-in user.
 *
 * Everything happens in `public.create_organization`, in one transaction:
 * the organization, the owner membership, and the `organization.created` and
 * `member.added` audit events. A failure anywhere leaves nothing behind.
 *
 * The function is called with the user's own session, so the owner is the
 * subject of the JWT Supabase Auth signed. No user ID is passed, so none can
 * be substituted, and no service-role key is used for a request the user's
 * own client can serve. The caller must still have called `requireSession()`
 * first; the database refuses a call without a user either way.
 *
 * The slug is the database's choice. It is never reported as taken: a
 * collision gets a random suffix instead (README §8).
 */
export async function createOrganization(
  name: OrganizationName,
): Promise<CreateOrganizationResult> {
  // The resolving client, as for the membership read: an auth-server hiccup
  // while refreshing here must not delete the session.
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase.rpc("create_organization", {
    p_name: name,
  });

  if (error) {
    if (error.code === "PT429") {
      return { status: "limited" };
    }
    // 22023 cannot happen for a validated name, and 42501 cannot happen
    // after requireSession(). Either would be a bug, so neither is dressed
    // up as the client's fault.
    throw new OrganizationCreationError(error.code, { cause: error });
  }

  return { status: "created", organization: serializeOrganization(data) };
}

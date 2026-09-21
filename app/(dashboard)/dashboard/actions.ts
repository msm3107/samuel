"use server";

import { redirect } from "next/navigation";

import { createOrganization } from "@/features/organizations/create-organization";
import { organizationNameSchema } from "@/features/organizations/organization";
import { requireDashboardSession } from "@/lib/auth/require-session";

import { DASHBOARD_PATH, type CreateOrganizationError } from "./messages";

/**
 * The dashboard's create form. Next.js refuses a server action whose Origin
 * does not match the host, which is its CSRF protection. The same steps as
 * `POST /api/organizations`: the session, then the name, then the database.
 *
 * Only the `name` field is read. Anything else the form, or a forged
 * request, carries is ignored: the owner is the session's user and the slug
 * is the database's choice.
 */
export async function createOrganizationAction(
  formData: FormData,
): Promise<void> {
  await requireDashboardSession();

  const name = organizationNameSchema.safeParse(
    formData instanceof FormData ? formData.get("name") : undefined,
  );
  if (!name.success) {
    redirectWithError("invalid_name");
  }

  const result = await createOrganization(name.data);
  if (result.status === "limited") {
    redirectWithError("limit_reached");
  }

  redirect(DASHBOARD_PATH);
}

function redirectWithError(code: CreateOrganizationError): never {
  redirect(`${DASHBOARD_PATH}?error=${code}`);
}

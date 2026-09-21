import Link from "next/link";

import { PRIMARY_BUTTON, TEXT_INPUT, TEXT_LINK } from "@/components/ui/styles";
import { listOrganizations } from "@/features/organizations/organization-queries";
import { requireDashboardSession } from "@/lib/auth/require-session";

import { createOrganizationAction } from "./actions";
import { systemsPath } from "./[organizationId]/systems/messages";
import { createOrganizationMessage } from "./messages";

/**
 * The signed-in user's organizations, and a form to create one. Checks the
 * session itself: Next.js can render a page without re-running the layout
 * above it, so every dashboard page does its own check. The call is memoized
 * per render, so it costs no second auth-server round trip.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireDashboardSession();
  const organizations = await listOrganizations();
  const errorMessage = createOrganizationMessage((await searchParams).error);

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>

      <section className="mt-10" aria-labelledby="organizations-heading">
        <h2 id="organizations-heading" className="text-xl font-semibold">
          Your organizations
        </h2>
        {organizations.length === 0 ? (
          <p className="mt-3 text-slate-700">
            You are not in any organization yet. Create one to get started.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 border-y border-slate-200">
            {organizations.map((organization) => (
              <li key={organization.id} className="py-3">
                {/* To the organization's AI systems (TASK-010). */}
                <Link href={systemsPath(organization.id)} className={TEXT_LINK}>
                  <bdi>{organization.name}</bdi>
                </Link>{" "}
                <span className="text-sm text-slate-500">
                  {organization.slug}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="create-heading">
        <h2 id="create-heading" className="text-xl font-semibold">
          Create an organization
        </h2>
        <form action={createOrganizationAction} className="mt-3 flex gap-3">
          <label htmlFor="organization-name" className="sr-only">
            Organization name
          </label>
          <input
            id="organization-name"
            name="name"
            required
            maxLength={120}
            autoComplete="organization"
            aria-describedby={
              errorMessage === null ? undefined : "create-organization-error"
            }
            className={`flex-1 ${TEXT_INPUT}`}
          />
          <button type="submit" className={PRIMARY_BUTTON}>
            Create
          </button>
        </form>
        {errorMessage === null ? null : (
          <p
            id="create-organization-error"
            role="alert"
            className="mt-2 text-sm text-red-700"
          >
            {errorMessage}
          </p>
        )}
      </section>
    </main>
  );
}

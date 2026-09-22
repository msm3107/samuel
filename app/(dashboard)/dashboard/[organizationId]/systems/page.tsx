import Link from "next/link";

import { Breadcrumbs } from "@/components/dashboard/breadcrumbs";
import { PRIMARY_BUTTON, TEXT_LINK } from "@/components/ui/styles";
import {
  aiSystemListFilterSchema,
  type AiSystemListFilter,
} from "@/features/ai-systems/ai-system";
import { SYSTEM_TYPE_LABELS } from "@/features/ai-systems/ai-system-form";
import {
  AI_SYSTEM_LIST_LIMIT,
  listAiSystems,
} from "@/features/ai-systems/ai-system-queries";
import { minimumRoleFor, roleSatisfies } from "@/lib/auth/organization-roles";

import {
  organizationAccessOrNotFound,
  organizationOrNotFound,
} from "../access";
import { systemPath, systemsPath } from "./messages";

type PageProps = {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const FILTERS: ReadonlyArray<{ value: AiSystemListFilter; label: string }> = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];

const EMPTY_MESSAGES = {
  active: "No active AI systems.",
  archived: "No archived AI systems.",
  all: "No AI systems registered yet.",
} as const satisfies Record<AiSystemListFilter, string>;

/**
 * An organization's AI systems (TASK-010). Viewers and up. The organization
 * is authorized from the path on every render; a layout's check is not
 * relied on, because Next.js can render a page without its layout.
 */
export default async function AiSystemsPage({
  params,
  searchParams,
}: PageProps) {
  const { organizationId } = await params;
  const access = await organizationAccessOrNotFound(
    organizationId,
    "organization.read",
  );
  const filter = listFilter((await searchParams).status);
  const [organization, { aiSystems, truncated }] = await Promise.all([
    organizationOrNotFound(access),
    listAiSystems(access, filter),
  ]);
  const canManage = roleSatisfies(
    access.role,
    minimumRoleFor("systems.manage"),
  );
  const listPath = systemsPath(access.organizationId);

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-12">
      <Breadcrumbs
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: organization.name },
          { label: "AI systems" },
        ]}
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">AI systems</h1>
        {canManage ? (
          <Link href={`${listPath}/new`} className={PRIMARY_BUTTON}>
            Register an AI system
          </Link>
        ) : null}
      </div>

      <nav aria-label="Filter by status" className="mt-6">
        <ul className="flex gap-4">
          {FILTERS.map(({ value, label }) => (
            <li key={value}>
              <Link
                href={
                  value === "active" ? listPath : `${listPath}?status=${value}`
                }
                aria-current={value === filter ? "page" : undefined}
                className={`${TEXT_LINK} ${value === filter ? "" : "font-normal no-underline"}`}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {aiSystems.length === 0 ? (
        <p className="mt-6 text-slate-700">{EMPTY_MESSAGES[filter]}</p>
      ) : (
        <table className="mt-6 w-full border-collapse text-left">
          <caption className="sr-only">
            {FILTERS.find(({ value }) => value === filter)?.label} AI systems
          </caption>
          <thead>
            <tr className="border-b border-slate-300 text-sm text-slate-700">
              <th scope="col" className="py-2 pr-4 font-medium">
                Name
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Type
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Provider
              </th>
              <th scope="col" className="py-2 font-medium">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {aiSystems.map((aiSystem) => (
              <tr key={aiSystem.id} className="border-b border-slate-200">
                <td className="py-3 pr-4">
                  <Link
                    href={systemPath(access.organizationId, aiSystem.id)}
                    className={TEXT_LINK}
                  >
                    <bdi>{aiSystem.name}</bdi>
                  </Link>
                </td>
                <td className="py-3 pr-4">
                  {SYSTEM_TYPE_LABELS[aiSystem.systemType]}
                </td>
                <td className="py-3 pr-4">
                  {aiSystem.provider === null ? (
                    <span className="text-slate-600">Not given</span>
                  ) : (
                    <bdi>{aiSystem.provider}</bdi>
                  )}
                </td>
                <td className="py-3">
                  {aiSystem.status === "active" ? "Active" : "Archived"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {truncated ? (
        <p role="note" className="mt-4 text-sm text-slate-700">
          Showing the first {AI_SYSTEM_LIST_LIMIT} systems, by name.
        </p>
      ) : null}
    </main>
  );
}

/**
 * An unknown or repeated `?status=` shows the active systems. On the API it
 * is a 400; here it only picks one of three fixed queries, and a bad
 * bookmark should not be an error page.
 */
function listFilter(value: string | string[] | undefined): AiSystemListFilter {
  const parsed = aiSystemListFilterSchema.safeParse(value);
  return parsed.success ? parsed.data : "active";
}

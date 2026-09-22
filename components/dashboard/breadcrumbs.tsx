import Link from "next/link";

import { TEXT_LINK } from "@/components/ui/styles";

export type Crumb = Readonly<{ label: string; href?: string }>;

/**
 * Where a dashboard page sits (TASK-010). The last crumb is the page itself,
 * marked `aria-current`; a crumb with no page of its own is plain text. Labels such as an organization's name
 * are direction-isolated, so a right-to-left name cannot reorder the trail.
 */
export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
        {crumbs.map((crumb, index) => (
          <li key={index} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.href === undefined ? (
              <span
                aria-current={index === crumbs.length - 1 ? "page" : undefined}
              >
                <bdi>{crumb.label}</bdi>
              </span>
            ) : (
              <Link href={crumb.href} className={TEXT_LINK}>
                <bdi>{crumb.label}</bdi>
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

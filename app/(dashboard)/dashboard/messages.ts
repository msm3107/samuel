export const DASHBOARD_PATH = "/dashboard";

/**
 * What the create form can report, each with fixed text. The page shows a
 * message only for a code in this table, so a crafted `?error=` link cannot
 * put words of its choosing on the page.
 */
export const CREATE_ORGANIZATION_MESSAGES = {
  invalid_name:
    "Enter a name of 1 to 120 characters, without line breaks or other control characters.",
  limit_reached:
    "You have created 10 organizations in the last hour. Please try again later.",
} as const;

export type CreateOrganizationError = keyof typeof CREATE_ORGANIZATION_MESSAGES;

export function createOrganizationMessage(value: unknown): string | null {
  return typeof value === "string" &&
    Object.hasOwn(CREATE_ORGANIZATION_MESSAGES, value)
    ? CREATE_ORGANIZATION_MESSAGES[value as CreateOrganizationError]
    : null;
}

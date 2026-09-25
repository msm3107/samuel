"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  disclosureFormValues,
  formValuesOf,
  parseDisclosureForm,
} from "@/features/disclosures/disclosure-form";
import { publishDisclosure } from "@/features/disclosures/disclosure-queries";
import { AuthorizationError } from "@/lib/auth/errors";

import { organizationAccessOrNull } from "../../../access";
import { disclosurePath, type DisclosureFormState } from "./messages";

/**
 * The disclosure editor's server action (TASK-018). Next.js refuses an
 * action whose Origin does not match the host, which is its CSRF protection.
 *
 * The organization and AI system are bound into the action by the page, but
 * bound arguments come back from the browser like any other request data, so
 * neither is trusted: the action authenticates, authorizes the organization,
 * and validates the rest, as the API route does. The query then uses the
 * authorized `access.organizationId`, not the argument.
 */

const systemIdSchema = z.uuid();

/** Publishes a version, if it follows the one the editor was showing. */
export async function publishDisclosureAction(
  organizationId: string,
  systemId: string,
  _previous: DisclosureFormState,
  formData: FormData,
): Promise<DisclosureFormState> {
  const access = await organizationAccessOrNull(
    organizationId,
    "disclosures.manage",
  );
  // Authorized before anything is validated, as the API route checks
  // permission before reading the body: a refused caller reaches no rule,
  // no schema and no query. Their own text does come back, so a role
  // changed mid-edit costs nobody their notice (PR #33 review, note 3); it
  // is the sender's own input, rendered only as a control's value.
  if (access === null) {
    return {
      result: "not_permitted",
      fields: [],
      values: disclosureFormValues(formData),
    };
  }
  const form = parseDisclosureForm(formData);
  const id = systemIdSchema.safeParse(systemId);
  if (!id.success) {
    return { result: "ai_system_not_found", fields: [], values: form.values };
  }
  if (!form.success) {
    return { result: "invalid", fields: form.fields, values: form.values };
  }
  // A version field that isn't a version number: only a forged or broken
  // request sends one, and publishing it as a first version would write
  // over whatever is current.
  if (form.expectedVersion.kind === "unreadable") {
    return { result: "stale", fields: [], values: form.values };
  }

  const result = await refusedAsNotPermitted(() =>
    publishDisclosure(access, id.data, form.data),
  );
  if (result.status !== "ok") {
    return { result: result.status, fields: [], values: form.values };
  }

  // Only this screen shows a disclosure, so only this screen is refreshed.
  revalidatePath(disclosurePath(access.organizationId, id.data));
  // What was published, trimmed and normalized, rather than what was typed,
  // and the version the next publish must name.
  return {
    result: "published",
    fields: [],
    values: formValuesOf(result.disclosure),
    version: result.disclosure.version,
  };
}

/**
 * A role lowered or removed after the check, which RLS refuses on the insert
 * (`42501`), answered in the form like any other refusal. Every other error
 * is thrown, and renders as an error page with a reference.
 */
async function refusedAsNotPermitted<T>(
  write: () => Promise<T>,
): Promise<T | { status: "not_permitted" }> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: "not_permitted" };
    }
    throw error;
  }
}

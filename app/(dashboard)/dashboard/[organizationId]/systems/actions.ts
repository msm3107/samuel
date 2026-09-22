"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { SYSTEM_STATUSES } from "@/features/ai-systems/ai-system";
import {
  formValuesOf,
  parseAiSystemEditForm,
  parseAiSystemForm,
} from "@/features/ai-systems/ai-system-form";
import {
  createAiSystem,
  updateAiSystem,
} from "@/features/ai-systems/ai-system-queries";
import { AuthorizationError } from "@/lib/auth/errors";

import { organizationAccessOrNull } from "../access";
import {
  systemPath,
  systemsPath,
  type AiSystemFormState,
  type AiSystemStatusState,
} from "./messages";

/**
 * The AI system forms' server actions (TASK-010). Next.js refuses an action
 * whose Origin does not match the host, which is its CSRF protection.
 *
 * The organization, system and status are bound into each action by the
 * page, but bound arguments come back from the browser like any other
 * request data, so none is trusted: each action authenticates, authorizes
 * the organization, and validates the rest, as the API routes do. Every query
 * then uses the authorized `access.organizationId`, not the argument.
 */

const systemIdSchema = z.uuid();
const statusSchema = z.enum(SYSTEM_STATUSES);

/** Registers a system, then opens it. */
export async function createAiSystemAction(
  organizationId: string,
  _previous: AiSystemFormState,
  formData: FormData,
): Promise<AiSystemFormState> {
  const access = await organizationAccessOrNull(
    organizationId,
    "systems.manage",
  );
  const form = parseAiSystemForm(formData);
  if (access === null) {
    return { result: "not_permitted", fields: [], values: form.values };
  }
  if (!form.success) {
    return { result: "invalid", fields: form.fields, values: form.values };
  }

  const result = await refusedAsNotPermitted(() =>
    createAiSystem(access, form.data),
  );
  if (result.status !== "ok") {
    return { result: result.status, fields: [], values: form.values };
  }

  revalidatePath(systemsPath(access.organizationId));
  redirect(systemPath(access.organizationId, result.aiSystem.id));
}

/** Saves the edit form: all four fields. */
export async function updateAiSystemAction(
  organizationId: string,
  systemId: string,
  _previous: AiSystemFormState,
  formData: FormData,
): Promise<AiSystemFormState> {
  const access = await organizationAccessOrNull(
    organizationId,
    "systems.manage",
  );
  const form = parseAiSystemEditForm(formData);
  if (access === null) {
    return { result: "not_permitted", fields: [], values: form.values };
  }
  const id = systemIdSchema.safeParse(systemId);
  if (!id.success) {
    return { result: "not_found", fields: [], values: form.values };
  }
  if (!form.success) {
    return { result: "invalid", fields: form.fields, values: form.values };
  }
  // No version, no save: the form always sends one, so only a forged or
  // broken request lacks it, and saving it blind could overwrite someone.
  if (form.version === null) {
    return { result: "stale", fields: [], values: form.values };
  }

  const result = await refusedAsNotPermitted(() =>
    updateAiSystem(access, id.data, form.data),
  );
  if (result.status !== "ok") {
    return { result: result.status, fields: [], values: form.values };
  }

  refreshScreens(access.organizationId, id.data);
  // What was stored, trimmed and normalized, rather than what was typed,
  // and the version the next edit must name.
  return {
    result: "saved",
    fields: [],
    values: formValuesOf(result.aiSystem),
    version: result.aiSystem.updatedAt,
  };
}

/**
 * Archives a system, or restores an archived one. No version is checked:
 * this changes only the status, so it can't undo anyone's edit, and a
 * second archive of an archived system changes nothing.
 */
export async function setAiSystemStatusAction(
  organizationId: string,
  systemId: string,
  status: string,
  _previous: AiSystemStatusState,
  _formData: FormData,
): Promise<AiSystemStatusState> {
  const access = await organizationAccessOrNull(
    organizationId,
    "systems.manage",
  );
  if (access === null) {
    return { result: "not_permitted" };
  }
  const id = systemIdSchema.safeParse(systemId);
  if (!id.success) {
    return { result: "not_found" };
  }
  const target = statusSchema.safeParse(status);
  if (!target.success) {
    return { result: "invalid" };
  }

  const result = await refusedAsNotPermitted(() =>
    updateAiSystem(access, id.data, { status: target.data }),
  );
  if (result.status === "stale") {
    // No version was named, so the database cannot answer this.
    throw new Error("A status change without a version was refused as stale");
  }
  if (result.status !== "ok") {
    return { result: result.status };
  }

  refreshScreens(access.organizationId, id.data);
  return { result: target.data === "archived" ? "archived" : "restored" };
}

/** The list and the system's own page show the change on their next view. */
function refreshScreens(organizationId: string, systemId: string): void {
  revalidatePath(systemsPath(organizationId));
  revalidatePath(systemPath(organizationId, systemId));
}

/**
 * A role lowered or removed after the check, which RLS refuses on an insert
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

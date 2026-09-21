import { describe, expect, it } from "vitest";

import {
  AI_SYSTEM_FORM_MESSAGES,
  AI_SYSTEM_STATUS_MESSAGES,
  FIELD_MESSAGES,
  isProblem,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/messages";
import { SYSTEM_TYPES } from "@/features/ai-systems/ai-system";
import {
  AI_SYSTEM_FORM_FIELDS,
  formValuesOf,
  parseAiSystemEditForm,
  parseAiSystemForm,
  SYSTEM_TYPE_LABELS,
} from "@/features/ai-systems/ai-system-form";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

const VALID = {
  name: "Support bot",
  systemType: "chatbot",
  provider: "",
  description: "",
};

describe("parseAiSystemForm (TASK-010)", () => {
  it("reads the four fields, trimmed, with blanks as none", () => {
    const parsed = parseAiSystemForm(
      form({ ...VALID, name: "  Support bot  ", provider: "   " }),
    );

    expect(parsed).toMatchObject({
      success: true,
      data: {
        name: "Support bot",
        systemType: "chatbot",
        provider: null,
        description: null,
      },
    });
  });

  it("ignores every other field, whatever it claims", () => {
    const parsed = parseAiSystemForm(
      form({
        ...VALID,
        organizationId: "8d0c7c1e-3f6a-4f3e-9d6b-2f1c5a7e9b10",
        id: "9a8b7c6d-5e4f-4a3b-8c2d-000000000001",
        status: "archived",
      }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data).sort()).toEqual([
      "description",
      "name",
      "provider",
      "systemType",
    ]);
  });

  it("stores a textarea's CR LF line breaks as LF", () => {
    const parsed = parseAiSystemForm(
      form({ ...VALID, description: "One\r\nTwo\rThree" }),
    );

    expect(parsed.success && parsed.data.description).toBe("One\nTwo\nThree");
  });

  it("names every refused field, in form order, and keeps what was typed", () => {
    const typed = {
      name: "",
      systemType: "spaceship",
      provider: "x".repeat(101),
      description: "fine",
    };

    const parsed = parseAiSystemForm(form(typed));

    expect(parsed).toEqual({
      success: false,
      fields: ["name", "systemType", "provider"],
      values: typed,
    });
  });

  it("refuses the characters the table refuses", () => {
    const bell = String.fromCodePoint(7);
    const rightToLeftOverride = String.fromCodePoint(0x202e);

    const parsed = parseAiSystemForm(
      form({
        ...VALID,
        name: `Bot${rightToLeftOverride}`,
        provider: `Acme${bell}`,
        description: `Line${bell}`,
      }),
    );

    expect(parsed.success || parsed.fields).toEqual([
      "name",
      "provider",
      "description",
    ]);
  });

  it("gives back at most 4,000 characters of a value, and still refuses it", () => {
    const parsed = parseAiSystemForm(
      form({ ...VALID, description: "x".repeat(1_000_000) }),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.values.description).toHaveLength(4000);
  });

  it("reads nothing from something that is not a form", () => {
    const parsed = parseAiSystemForm({ name: "Support bot" });

    expect(parsed).toMatchObject({
      success: false,
      values: { name: "", systemType: "", provider: "", description: "" },
    });
  });
});

describe("parseAiSystemEditForm", () => {
  it("names all four fields, so emptying one clears it", () => {
    const parsed = parseAiSystemEditForm(form(VALID));

    expect(parsed.success && parsed.data).toEqual({
      name: "Support bot",
      systemType: "chatbot",
      provider: null,
      description: null,
    });
  });

  it("refuses as the create form does", () => {
    expect(parseAiSystemEditForm(form({ ...VALID, name: " " })).success).toBe(
      false,
    );
  });
});

describe("formValuesOf", () => {
  it("shows a stored system, with none as blank", () => {
    expect(
      formValuesOf({
        id: "9a8b7c6d-5e4f-4a3b-8c2d-000000000001",
        name: "Support bot",
        systemType: "assistant",
        provider: null,
        description: null,
        status: "active",
      }),
    ).toEqual({
      name: "Support bot",
      systemType: "assistant",
      provider: "",
      description: "",
    });
  });
});

describe("messages", () => {
  it("labels every system type", () => {
    expect(Object.keys(SYSTEM_TYPE_LABELS).sort()).toEqual(
      [...SYSTEM_TYPES].sort(),
    );
  });

  it("explains every field", () => {
    expect(Object.keys(FIELD_MESSAGES).sort()).toEqual(
      [...AI_SYSTEM_FORM_FIELDS].sort(),
    );
  });

  it("marks only a success as not a problem", () => {
    expect(isProblem("saved")).toBe(false);
    expect(isProblem("archived")).toBe(false);
    expect(isProblem("restored")).toBe(false);
    for (const result of [
      "invalid",
      "name_taken",
      "not_permitted",
      "not_found",
    ] as const) {
      expect(isProblem(result)).toBe(true);
    }
  });

  it("has text for every result", () => {
    for (const text of [
      ...Object.values(AI_SYSTEM_FORM_MESSAGES),
      ...Object.values(AI_SYSTEM_STATUS_MESSAGES),
    ]) {
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

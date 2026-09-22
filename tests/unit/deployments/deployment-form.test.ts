import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  DEPLOYMENT_FORM_MESSAGES,
  DEPLOYMENT_STATUS_MESSAGES,
  HOSTNAME_MESSAGES,
  isStatusProblem,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/messages";
import { Hostname } from "@/components/dashboard/hostname";
import { HOSTNAME_ERROR_CODES } from "@/features/deployments/deployment";
import { HOSTNAME_FIELD } from "@/features/deployments/deployment-fields";
import { parseDeploymentForm } from "@/features/deployments/deployment-form";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

describe("parseDeploymentForm (TASK-015)", () => {
  it("reads the hostname field, and ignores every other field", () => {
    const parsed = parseDeploymentForm(
      form({
        [HOSTNAME_FIELD]: "a.com",
        organizationId: "8d0c7c1e-3f6a-4f3e-9d6b-2f1c5a7e9b10",
        aiSystemId: "9a8b7c6d-5e4f-4a3b-8c2d-000000000001",
        status: "archived",
        public_id: "dep_forged",
        publicId: "dep_forged",
      }),
    );

    expect(parsed).toMatchObject({ success: true, hostname: "a.com" });
  });

  it("something that is not a FormData reads no hostname, and value is empty", () => {
    const parsed = parseDeploymentForm({ [HOSTNAME_FIELD]: "a.com" });

    expect(parsed).toEqual({
      success: false,
      code: "hostname_invalid",
      value: "",
    });
  });

  it("a form with no hostname field reads it as empty", () => {
    const parsed = parseDeploymentForm(form({}));

    expect(parsed).toEqual({
      success: false,
      code: "hostname_invalid",
      value: "",
    });
  });

  it("a File where the hostname should be reads as empty, not the file's name", () => {
    const data = new FormData();
    data.append(
      HOSTNAME_FIELD,
      new File(["irrelevant"], "a.com", { type: "text/plain" }),
    );

    const parsed = parseDeploymentForm(data);

    expect(parsed).toEqual({
      success: false,
      code: "hostname_invalid",
      value: "",
    });
  });

  it.each([
    ["", "hostname_invalid"],
    ["ftp://a.com", "hostname_scheme_not_allowed"],
    ["https://u:p@a.com", "hostname_credentials_not_allowed"],
    ["localhost", "hostname_private_network"],
    ["8.8.8.8", "hostname_ip_address_not_allowed"],
    ["a.com:8080", "hostname_port_not_allowed"],
    ["https://a.com/x", "hostname_path_not_allowed"],
  ] as const)(
    "maps TASK-012's refusal for %s to %s, and keeps what was typed",
    (typed, code) => {
      const parsed = parseDeploymentForm(form({ [HOSTNAME_FIELD]: typed }));

      expect(parsed).toEqual({ success: false, code, value: typed });
    },
  );

  it("normalizes a valid address, but keeps the typed text as the value", () => {
    const typed = "HTTPS://Bücher.DE/";

    const parsed = parseDeploymentForm(form({ [HOSTNAME_FIELD]: typed }));

    expect(parsed).toEqual({
      success: true,
      hostname: "xn--bcher-kva.de",
      value: typed,
    });
  });

  it("echoes at most 2,048 characters, and still refuses it", () => {
    const typed = "a".repeat(5000);

    const parsed = parseDeploymentForm(form({ [HOSTNAME_FIELD]: typed }));

    expect(parsed.success).toBe(false);
    expect(parsed.value).toHaveLength(2048);
  });
});

describe("messages", () => {
  it("has text for every result", () => {
    for (const text of [
      ...Object.values(DEPLOYMENT_FORM_MESSAGES),
      ...Object.values(DEPLOYMENT_STATUS_MESSAGES),
    ]) {
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("has a message for every one of TASK-012's failure codes", () => {
    for (const code of Object.values(HOSTNAME_ERROR_CODES)) {
      expect(HOSTNAME_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });

  it("marks only archived and restored as not a problem", () => {
    expect(isStatusProblem("archived")).toBe(false);
    expect(isStatusProblem("restored")).toBe(false);
    for (const result of [
      "exists",
      "ai_system_archived",
      "not_permitted",
      "not_found",
      "invalid",
    ] as const) {
      expect(isStatusProblem(result)).toBe(true);
    }
  });
});

describe("Hostname (TASK-015)", () => {
  it("renders one bdi, direction-fixed, when the ASCII and Unicode forms match", () => {
    const html = renderToStaticMarkup(
      createElement(Hostname, {
        hostname: "example.com",
        unicodeHostname: "example.com",
      }),
    );

    expect(html).toBe('<bdi dir="ltr">example.com</bdi>');
  });

  it("renders both forms, each direction-fixed, for a punycode name", () => {
    const html = renderToStaticMarkup(
      createElement(Hostname, {
        hostname: "xn--bcher-kva.de",
        unicodeHostname: "bücher.de",
      }),
    );

    expect(html).toContain('<bdi dir="ltr">bücher.de</bdi>');
    expect(html).toContain('<bdi dir="ltr">xn--bcher-kva.de</bdi>');
    expect((html.match(/<bdi dir="ltr">/g) ?? []).length).toBe(2);
  });

  it('never renders a hostname with dir="auto"', () => {
    const matching = renderToStaticMarkup(
      createElement(Hostname, {
        hostname: "example.com",
        unicodeHostname: "example.com",
      }),
    );
    const differing = renderToStaticMarkup(
      createElement(Hostname, {
        hostname: "xn--bcher-kva.de",
        unicodeHostname: "bücher.de",
      }),
    );

    expect(matching).not.toContain('dir="auto"');
    expect(differing).not.toContain('dir="auto"');
  });
});

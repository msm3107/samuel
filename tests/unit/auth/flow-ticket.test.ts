import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (value === "" || options?.maxAge === 0) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
  }),
}));

import {
  consumeFlowTicket,
  FLOW_TICKET_COOKIE,
  issueFlowTicket,
  readFlowTicket,
} from "@/lib/auth/sign-in/flow-ticket";
import { serverEnv } from "@/lib/env/server-env";

afterEach(() => {
  jar.clear();
});

function issued() {
  const value = jar.get(FLOW_TICKET_COOKIE);
  if (!value) {
    throw new Error("no ticket was issued");
  }
  return value;
}

function forge(issuedAt: number, nonce: string, secret: string) {
  const signature = createHmac("sha256", secret)
    .update(`flow-ticket:v1:${issuedAt}:${nonce}`)
    .digest("hex");
  return `${issuedAt}.${nonce}.${signature}`;
}

const NONCE = "a".repeat(32);
const now = () => Math.floor(Date.now() / 1000);

describe("issueFlowTicket", () => {
  it("issues a ticket this application accepts", async () => {
    await issueFlowTicket();

    expect(readFlowTicket(issued())).toMatch(/^[0-9a-f]{32}$/);
  });

  it("issues a different nonce every time, so tickets are not interchangeable", async () => {
    await issueFlowTicket();
    const first = readFlowTicket(issued());
    jar.clear();
    await issueFlowTicket();

    expect(readFlowTicket(issued())).not.toBe(first);
  });
});

describe("readFlowTicket", () => {
  it.each([
    ["nothing", undefined],
    ["a non-string", 42],
    ["an empty string", ""],
    ["a value of the wrong shape", "not-a-ticket"],
    ["a ticket with no signature", `${now()}.${NONCE}.`],
    ["a signature that is not hex", `${now()}.${NONCE}.${"z".repeat(64)}`],
  ])("refuses %s", (_label, value) => {
    expect(readFlowTicket(value)).toBeNull();
  });

  it("refuses a ticket signed with another secret", () => {
    expect(
      readFlowTicket(forge(now(), NONCE, "another-secret-value")),
    ).toBeNull();
  });

  it("refuses a ticket whose nonce was swapped after signing", () => {
    const secret = serverEnv().RATE_LIMIT_HMAC_SECRET;
    const ticket = forge(now(), NONCE, secret);
    const [issuedAt = "", , signature = ""] = ticket.split(".");

    expect(
      readFlowTicket(`${issuedAt}.${"b".repeat(32)}.${signature}`),
    ).toBeNull();
  });

  it("refuses a ticket whose issue time was moved forward after signing", () => {
    const secret = serverEnv().RATE_LIMIT_HMAC_SECRET;
    const [, nonce = "", signature = ""] = forge(
      now() - 7200,
      NONCE,
      secret,
    ).split(".");

    expect(readFlowTicket(`${now()}.${nonce}.${signature}`)).toBeNull();
  });

  it("refuses a ticket older than an hour, as GoTrue's own links expire", () => {
    const secret = serverEnv().RATE_LIMIT_HMAC_SECRET;

    expect(readFlowTicket(forge(now() - 3601, NONCE, secret))).toBeNull();
    expect(readFlowTicket(forge(now() - 3599, NONCE, secret))).toBe(NONCE);
  });

  it("refuses a ticket issued in the future", () => {
    const secret = serverEnv().RATE_LIMIT_HMAC_SECRET;

    expect(readFlowTicket(forge(now() + 120, NONCE, secret))).toBeNull();
  });
});

describe("consumeFlowTicket", () => {
  it("returns the nonce and takes the ticket out of the browser", async () => {
    await issueFlowTicket();
    const nonce = readFlowTicket(issued());

    await expect(consumeFlowTicket()).resolves.toBe(nonce);
    expect(jar.has(FLOW_TICKET_COOKIE)).toBe(false);
    await expect(consumeFlowTicket()).resolves.toBeNull();
  });

  it("leaves an invalid ticket alone rather than reporting one", async () => {
    jar.set(FLOW_TICKET_COOKIE, "forged");

    await expect(consumeFlowTicket()).resolves.toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  callbackErrorMessage,
  magicLinkMessage,
} from "@/app/(auth)/sign-in/sign-in-messages";
import { CALLBACK_ERROR_CODES } from "@/lib/auth/sign-in/result-codes";

describe("magic-link messages", () => {
  it("tells an unknown address exactly what it tells a known one", () => {
    // The screen only ever sees `link_sent`, whether or not the address has an
    // account, so there is one message for both.
    expect(magicLinkMessage("link_sent")).toEqual({
      tone: "confirmation",
      text: expect.stringContaining("Check your email"),
    });
  });

  it("says nothing about whether an account exists", () => {
    const everyMessage = (
      ["link_sent", "invalid_email", "unavailable"] as const
    )
      .map((result) => magicLinkMessage(result).text.toLowerCase())
      .join(" ");

    for (const revealing of [
      "no account",
      "not registered",
      "unknown address",
      "already registered",
      "sign up",
    ]) {
      expect(everyMessage).not.toContain(revealing);
    }
  });

  it("marks a problem by words, not by colour alone", () => {
    expect(magicLinkMessage("invalid_email").tone).toBe("problem");
    expect(magicLinkMessage("unavailable").tone).toBe("problem");
    expect(magicLinkMessage("link_sent").tone).toBe("confirmation");
  });
});

describe("callback error messages", () => {
  it("has a distinct message for every allowlisted code", () => {
    const messages = CALLBACK_ERROR_CODES.map((code) =>
      callbackErrorMessage(code),
    );

    expect(messages.every((message) => typeof message === "string")).toBe(true);
    expect(new Set(messages).size).toBe(CALLBACK_ERROR_CODES.length);
  });

  it("explains the same-browser rule when a link was opened elsewhere", () => {
    expect(callbackErrorMessage("link_other_browser")).toContain(
      "same browser",
    );
  });

  it("renders nothing when there is no error", () => {
    expect(callbackErrorMessage(undefined)).toBeUndefined();
  });

  it.each([
    ["an unknown code", "totally-made-up"],
    ["a script payload", "<script>alert(1)</script>"],
    ["an auth-server message", "Invalid Refresh Token: Already Used"],
    ["a prototype name", "toString"],
    ["a different case", "LINK_EXPIRED"],
    ["an empty string", ""],
  ])(
    "shows the generic message for %s and never echoes it",
    (_label, value) => {
      const message = callbackErrorMessage(value);

      expect(message).toBe("Sign-in did not complete. Try again below.");
      if (value !== "") {
        expect(message).not.toContain(value);
      }
    },
  );
});

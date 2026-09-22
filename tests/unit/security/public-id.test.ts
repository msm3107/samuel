import { describe, expect, it } from "vitest";

import {
  isPublicDeploymentId,
  PUBLIC_DEPLOYMENT_ID_PATTERN,
} from "@/lib/security/public-id";

describe("isPublicDeploymentId", () => {
  it.each([
    "dep_abcdefghijklmnopqrstuvwxyz",
    "dep_234567234567234567234567ab",
    "dep_jmxeb4fg6ybvfykwxbe4mql72n",
  ])("accepts %s", (value) => {
    expect(isPublicDeploymentId(value)).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["the prefix alone", "dep_"],
    ["25 characters", "dep_abcdefghijklmnopqrstuvwxy"],
    ["27 characters", "dep_abcdefghijklmnopqrstuvwxyza"],
    ["uppercase", "dep_ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    ["a digit outside base32 (0)", "dep_0bcdefghijklmnopqrstuvwxyz"],
    ["a digit outside base32 (1)", "dep_1bcdefghijklmnopqrstuvwxyz"],
    ["a digit outside base32 (8)", "dep_8bcdefghijklmnopqrstuvwxyz"],
    ["another prefix", "sys_abcdefghijklmnopqrstuvwxyz"],
    ["README's example format", "dep_public_V7P4j4ATm9qW"],
    ["a leading space", " dep_abcdefghijklmnopqrstuvwxyz"],
    ["a trailing newline", "dep_abcdefghijklmnopqrstuvwxyz\n"],
    ["a UUID", "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"],
  ])("refuses %s", (_label, value) => {
    expect(isPublicDeploymentId(value)).toBe(false);
  });

  it.each([null, undefined, 42, {}, ["dep_abcdefghijklmnopqrstuvwxyz"]])(
    "refuses a non-string: %j",
    (value) => {
      expect(isPublicDeploymentId(value)).toBe(false);
    },
  );

  it("matches the database's constraint", () => {
    // supabase/migrations/20260922180000_deployment_public_id.sql
    expect(PUBLIC_DEPLOYMENT_ID_PATTERN.source).toBe("^dep_[a-z2-7]{26}$");
  });
});

import { describe, expect, it } from "vitest";

import {
  ORGANIZATION_PERMISSIONS,
  ORGANIZATION_ROLES,
  roleSatisfies,
  type OrganizationPermission,
  type OrganizationRole,
} from "@/lib/auth/organization-roles";

describe("ORGANIZATION_ROLES", () => {
  it("orders roles least privileged first: viewer, member, admin, owner", () => {
    expect(ORGANIZATION_ROLES).toEqual(["viewer", "member", "admin", "owner"]);
  });
});

describe("roleSatisfies", () => {
  // Every role/minimumRole pair (4x4), including all 4 equality cases. Each
  // expected value is written out literally rather than derived from the
  // hierarchy, so a bug in the hierarchy comparison cannot also produce the
  // "expected" side of the assertion.
  it.each`
    role        | minimumRole | expected
    ${"viewer"} | ${"viewer"} | ${true}
    ${"viewer"} | ${"member"} | ${false}
    ${"viewer"} | ${"admin"}  | ${false}
    ${"viewer"} | ${"owner"}  | ${false}
    ${"member"} | ${"viewer"} | ${true}
    ${"member"} | ${"member"} | ${true}
    ${"member"} | ${"admin"}  | ${false}
    ${"member"} | ${"owner"}  | ${false}
    ${"admin"}  | ${"viewer"} | ${true}
    ${"admin"}  | ${"member"} | ${true}
    ${"admin"}  | ${"admin"}  | ${true}
    ${"admin"}  | ${"owner"}  | ${false}
    ${"owner"}  | ${"viewer"} | ${true}
    ${"owner"}  | ${"member"} | ${true}
    ${"owner"}  | ${"admin"}  | ${true}
    ${"owner"}  | ${"owner"}  | ${true}
  `(
    "roleSatisfies($role, $minimumRole) === $expected",
    ({
      role,
      minimumRole,
      expected,
    }: {
      role: OrganizationRole;
      minimumRole: OrganizationRole;
      expected: boolean;
    }) => {
      expect(roleSatisfies(role, minimumRole)).toBe(expected);
    },
  );
});

describe("ORGANIZATION_PERMISSIONS", () => {
  it("matches README §10 exactly, with no permission added or removed", () => {
    expect(ORGANIZATION_PERMISSIONS).toStrictEqual({
      "organization.read": "viewer",
      "systems.manage": "member",
      "deployments.manage": "member",
      "disclosures.manage": "member",
      "reports.generate": "member",
      "members.manage": "admin",
      "billing.manage": "owner",
      "ownership.transfer": "owner",
    });
  });
});

/**
 * Which permissions each role holds, per README §10, written out literally
 * (not derived from `ORGANIZATION_PERMISSIONS` or the hierarchy) so the
 * expectation cannot silently drift with the table it is checking.
 */
const EXPECTED_PERMISSIONS_BY_ROLE: Record<
  OrganizationRole,
  OrganizationPermission[]
> = {
  viewer: ["organization.read"],
  member: [
    "organization.read",
    "systems.manage",
    "deployments.manage",
    "disclosures.manage",
    "reports.generate",
  ],
  admin: [
    "organization.read",
    "systems.manage",
    "deployments.manage",
    "disclosures.manage",
    "reports.generate",
    "members.manage",
  ],
  owner: [
    "organization.read",
    "systems.manage",
    "deployments.manage",
    "disclosures.manage",
    "reports.generate",
    "members.manage",
    "billing.manage",
    "ownership.transfer",
  ],
};

describe("permissions held by each role", () => {
  it.each(ORGANIZATION_ROLES)(
    "role %s holds exactly its README §10 permissions",
    (role) => {
      const held = (
        Object.keys(ORGANIZATION_PERMISSIONS) as OrganizationPermission[]
      )
        .filter((permission) =>
          roleSatisfies(role, ORGANIZATION_PERMISSIONS[permission]),
        )
        .sort();

      expect(held).toEqual([...EXPECTED_PERMISSIONS_BY_ROLE[role]].sort());
    },
  );

  it("viewer holds read-only access and nothing else", () => {
    const held = (
      Object.keys(ORGANIZATION_PERMISSIONS) as OrganizationPermission[]
    ).filter((permission) =>
      roleSatisfies("viewer", ORGANIZATION_PERMISSIONS[permission]),
    );
    expect(held).toEqual(["organization.read"]);
  });

  it("owner holds every permission", () => {
    const held = (
      Object.keys(ORGANIZATION_PERMISSIONS) as OrganizationPermission[]
    ).filter((permission) =>
      roleSatisfies("owner", ORGANIZATION_PERMISSIONS[permission]),
    );
    expect(held.sort()).toEqual(
      (
        Object.keys(ORGANIZATION_PERMISSIONS) as OrganizationPermission[]
      ).sort(),
    );
  });
});

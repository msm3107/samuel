import { describe, expect, it } from "vitest";

import {
  assertOrganizationRole,
  minimumRoleFor,
  ORGANIZATION_PERMISSIONS,
  ORGANIZATION_ROLES,
  roleSatisfies,
  UnknownPermissionError,
  UnknownRoleError,
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
      "organization.update": "admin",
      "members.read": "admin",
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
    "organization.update",
    "members.read",
    "members.manage",
  ],
  owner: [
    "organization.read",
    "systems.manage",
    "deployments.manage",
    "disclosures.manage",
    "reports.generate",
    "organization.update",
    "members.read",
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

/**
 * A name outside the hierarchy used to rank at -1, below every real role, so
 * a misspelt minimum admitted everyone (review of PR #19). Types stop these;
 * a cast or a configuration value does not, hence the casts here.
 */
describe("names that are not roles or permissions", () => {
  const unknownRoles = ["Owner", "superadmin", "", "constructor", "__proto__"];

  it.each(unknownRoles)(
    "roleSatisfies throws for the unknown minimum role %j",
    (name) => {
      expect(() => roleSatisfies("viewer", name as OrganizationRole)).toThrow(
        UnknownRoleError,
      );
      expect(() => roleSatisfies("owner", name as OrganizationRole)).toThrow(
        UnknownRoleError,
      );
    },
  );

  it.each(unknownRoles)(
    "roleSatisfies throws for the unknown held role %j",
    (name) => {
      expect(() => roleSatisfies(name as OrganizationRole, "viewer")).toThrow(
        UnknownRoleError,
      );
    },
  );

  it.each([undefined, null, 3, {}])(
    "assertOrganizationRole throws for the non-string %j",
    (value) => {
      expect(() => assertOrganizationRole(value)).toThrow(UnknownRoleError);
    },
  );

  it.each([
    "billing:manage",
    "Billing.manage",
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
  ])("minimumRoleFor throws for the unknown permission %j", (name) => {
    expect(() => minimumRoleFor(name as OrganizationPermission)).toThrow(
      UnknownPermissionError,
    );
  });

  it("minimumRoleFor returns the table's role for every real permission", () => {
    for (const [permission, role] of Object.entries(ORGANIZATION_PERMISSIONS)) {
      expect(minimumRoleFor(permission as OrganizationPermission)).toBe(role);
    }
  });

  it("does not echo the unknown name in the error message", () => {
    expect(() =>
      minimumRoleFor("billing:manage" as OrganizationPermission),
    ).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining("billing"),
      }),
    );
  });
});

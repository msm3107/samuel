import { describe, expect, it } from "vitest";

import {
  installReadiness,
  type InstallReadinessState,
} from "@/features/deployments/install-readiness";
import { INSTALL_READINESS_MESSAGES } from "@/app/(dashboard)/dashboard/[organizationId]/deployments/messages";

/**
 * Whether an installed tag would render anything (TASK-021).
 *
 * These are the conditions `public.public_disclosure` applies, restated for
 * the one audience entitled to be told them apart. The endpoint answers the
 * same way for all of them on purpose, so a drift here is not a drift that
 * any test of the endpoint can catch — which is why every state is asserted
 * rather than sampled.
 */

const live = { version: 4, enabled: true };
const off = { version: 4, enabled: false };

describe("installation readiness", () => {
  it("is live only when every condition the lookup applies holds", () => {
    expect(
      installReadiness({
        deploymentStatus: "active",
        aiSystemStatus: "active",
        current: live,
      }),
    ).toEqual({ state: "live", version: 4 });
  });

  it("reports the deployment first, even under an archived system", () => {
    // Both are wrong, but this page is about the deployment, and its
    // restore control is the one on this screen.
    expect(
      installReadiness({
        deploymentStatus: "archived",
        aiSystemStatus: "archived",
        current: live,
      }),
    ).toEqual({ state: "deployment_archived" });
  });

  it("reports the system when only the system is archived", () => {
    expect(
      installReadiness({
        deploymentStatus: "active",
        aiSystemStatus: "archived",
        current: live,
      }),
    ).toEqual({ state: "system_archived" });
  });

  it("tells a system that never published from one that turned it off", () => {
    const common = {
      deploymentStatus: "active",
      aiSystemStatus: "active",
    } as const;

    expect(installReadiness({ ...common, current: null })).toEqual({
      state: "never_published",
    });
    // `enabled` is required of the current version: an older enabled one
    // does not stand in for it, exactly as the SQL has it.
    expect(installReadiness({ ...common, current: off })).toEqual({
      state: "disabled",
      version: 4,
    });
  });

  it("says something specific for every state it can report", () => {
    const states = new Set<InstallReadinessState>();
    for (const deploymentStatus of ["active", "archived"] as const) {
      for (const aiSystemStatus of ["active", "archived"] as const) {
        for (const current of [null, live, off]) {
          states.add(
            installReadiness({ deploymentStatus, aiSystemStatus, current })
              .state,
          );
        }
      }
    }

    // Every reachable state, and no message without a state to show it.
    expect([...states].sort()).toEqual(
      Object.keys(INSTALL_READINESS_MESSAGES).sort(),
    );
    const said = Object.values(INSTALL_READINESS_MESSAGES);
    expect(new Set(said).size).toBe(said.length);
  });
});

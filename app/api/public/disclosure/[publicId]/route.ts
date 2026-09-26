import { lookupPublicDisclosure } from "@/features/disclosures/public-disclosure-queries";
import {
  handlePublicRequest,
  publicJsonResponse,
  PublicRequestError,
} from "@/lib/http/public-api";
import { logger } from "@/lib/logging/logger";
import { oncePerWindow } from "@/lib/logging/once-per-window";
import { requestNetwork } from "@/lib/security/client-ip";
import { isPublicDeploymentId } from "@/lib/security/public-id";
import {
  consumeRateLimit,
  GLOBAL,
  RATE_LIMITS,
  RateLimitUnavailableError,
} from "@/lib/security/rate-limit";

const ROUTE = "GET /api/public/disclosure/[publicId]";

/** A constant, never anything from a request: see `oncePerWindow`. */
const CEILING_ALERT_KEY = "public_disclosure:ceiling";

type RouteContext = { params: Promise<{ publicId: string }> };

/**
 * The public disclosure endpoint (TASK-019a): the one request the whole
 * internet may make. It takes a public deployment identifier and answers
 * with the notice that deployment should show — `version`, `language`,
 * `message` — or with nothing at all.
 *
 * No session is read and no cookie is touched: the answer depends on the
 * URL alone, which is what lets a shared cache hold it for a minute.
 *
 * A public identifier names what to render; it is never authorization
 * (README §11, §67). Everything returned here is meant to be read by anyone
 * who visits the customer's site.
 */
export async function GET(request: Request, { params }: RouteContext) {
  return handlePublicRequest(ROUTE, async () => {
    const { publicId } = await params;

    // The shape check first (PR #35 review, note 4). `isPublicDeploymentId`
    // accepts only `dep_` and 26 lowercase base32 characters, so a
    // wrong-cased or truncated identifier is refused here instead of
    // falling through to the same empty answer a withdrawn notice gives —
    // the failure is at least legible to whoever mistyped it. This is no
    // oracle: the shape is published, and refusing on it says nothing about
    // which deployments exist.
    //
    // It also makes junk the cheapest thing this endpoint does: a regex, no
    // limiter call, no query. The limiter exists to protect the database,
    // and a request that cannot reach the database needs no permission from
    // it.
    if (!isPublicDeploymentId(publicId)) {
      throw new PublicRequestError(400, "invalid_deployment_id");
    }

    await assertWithinRateLimits(request);

    const disclosure = await lookupPublicDisclosure(publicId);
    // One answer for all six reasons there is nothing to show (owner,
    // 2026-09-25): unknown, archived deployment, archived system, deleted
    // organization, never published, withdrawn.
    if (disclosure === null) {
      throw new PublicRequestError(404, "disclosure_not_found");
    }
    return publicJsonResponse(disclosure);
  });
}

/**
 * Refuses a network that is asking for far more than a browser does, and
 * counts every served request against a service-wide total.
 *
 * A refusal writes no log entry. Past the limit every further request would
 * write one, which would hand the caller this application's log volume —
 * the same reason the `404` carries no reference. The service-wide alert
 * below is the signal that something is happening, and it is bounded to one
 * entry per window.
 *
 * If the limiter cannot answer, `RateLimitUnavailableError` reaches
 * `handlePublicRequest` and the request is refused as unavailable: a limit
 * that disappears when the database is slow protects nothing. Here that
 * costs nothing extra — the limiter and the lookup are the same database,
 * so an outage of one is an outage of the answer.
 */
async function assertWithinRateLimits(request: Request): Promise<void> {
  if (
    !(await consumeRateLimit(
      "publicDisclosureNetwork",
      requestNetwork(request.headers),
    ))
  ) {
    throw new PublicRequestError(
      429,
      "rate_limited",
      RATE_LIMITS.publicDisclosureNetwork.windowSeconds,
    );
  }
  await countServiceWide();
}

/**
 * The service-wide counter alerts and never refuses (owner, 2026-09-26): a
 * ceiling that refused would take every customer's notice off every
 * customer's site at once, decided by whoever is making the noise. So
 * nothing here can fail the request, including the counter's own failure.
 */
async function countServiceWide(): Promise<void> {
  try {
    if (await consumeRateLimit("publicDisclosureGlobal", GLOBAL)) {
      return;
    }
    // Past the ceiling, calling the alert bucket on every request would add
    // a third database write per request at the exact moment the service is
    // busiest (PR #36 review, note 2). This process asks at most once per
    // window; the bucket then decides whether the entry is written, so the
    // log stays bounded across instances as well as within one.
    if (
      !oncePerWindow(
        CEILING_ALERT_KEY,
        RATE_LIMITS.publicDisclosureCeilingAlert.windowSeconds,
      )
    ) {
      return;
    }
    // Once per window, so the flood does not decide the error volume either.
    if (await consumeRateLimit("publicDisclosureCeilingAlert", GLOBAL)) {
      logger.error({ event: "public_disclosure_ceiling_reached" });
    }
  } catch (error) {
    if (!(error instanceof RateLimitUnavailableError)) {
      throw error;
    }
    logger.warn({ event: "public_disclosure_counter_unavailable" });
  }
}

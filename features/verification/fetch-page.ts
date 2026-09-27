import "server-only";

import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib";

import { serverEnv } from "@/lib/env/server-env";
import {
  type AddressResolver,
  createGuardedLookup,
  createLookupRecord,
  type LookupRecord,
} from "@/lib/security/verification-lookup";
import {
  type RedirectRefusal,
  validateRedirectTarget,
} from "@/lib/security/verification-target";

import type {
  VerificationFailureCode,
  VerificationMetadata,
} from "@/features/verification/verification-check";

/**
 * The verifier's fetch (TASK-023; README §17, §18). It asks a deployment's
 * home page for its HTML, under four bounds, revalidating every redirect, and
 * never opening a socket to an address `isPublicAddress` refuses.
 *
 * Nothing calls it yet. TASK-024 inspects the bytes it returns, TASK-025
 * schedules the call and writes the evidence row.
 *
 * Why `node:http` rather than `fetch`: each bound has to map to its own §19
 * code — a connection that never opened is a different fact from one that
 * opened and never finished — and the address that was validated has to be
 * the address connected to. `fetch` offers one `AbortSignal` and no seam for
 * either. Rejected: adding `undici` for a dispatcher with a `connect`
 * option, a dependency for something Node already has (§56).
 *
 * The transport does not interpret what it fetched. It returns bytes and the
 * `Content-Type` it was given; charset detection is part of reading HTML, and
 * that is TASK-024.
 */

/**
 * The bounds, settled by the owner on 2026-09-27. Module constants, not
 * options: a caller that could widen them could widen them for a hostile
 * target.
 *
 * 1 MiB clears the HTML of nearly every real site, so `RESPONSE_TOO_LARGE`
 * stays a real finding rather than a routine false failure on a heavy page.
 * 15 seconds is what one deliberately slow site may cost, and TASK-025 sizes
 * its batches knowing it. Five hops covers apex → www → locale chains.
 */
export const VERIFICATION_FETCH_BOUNDS = Object.freeze({
  connectMs: 5_000,
  totalMs: 15_000,
  maxBodyBytes: 1_048_576,
  maxRedirects: 5,
});

/**
 * The ports the verifier fetches on. A deployment has no port (TASK-011) and
 * `validateVerificationTarget` refuses one, so these are the only two it ever
 * uses, and they are not part of any URL it builds — a hop that resolves to a
 * ported URL is still `PORT_NOT_ALLOWED`.
 */
const DEFAULT_PORTS = Object.freeze({ http: 80, https: 443 });

export type VerificationFetchPorts = Readonly<{ http: number; https: number }>;

/** The statuses that carry a `Location` worth following. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * When a failed HTTPS attempt is retried over plain HTTP (owner's decision,
 * 2026-09-27): only when the connection itself did not happen. A resolver
 * failure would fail the same way twice, a blocked address is a policy
 * answer, and a server that responded has answered.
 */
const RETRY_OVER_HTTP = new Set<VerificationFailureCode>([
  "CONNECTION_FAILED",
  "CONNECTION_TIMEOUT",
]);

export type VerificationFetchResult =
  | Readonly<{
      ok: true;
      httpStatus: number;
      body: Buffer;
      metadata: VerificationMetadata;
    }>
  | Readonly<{
      ok: false;
      code: VerificationFailureCode;
      httpStatus: number | null;
      /** Why a hop was refused, for a log. Never stored (README §19). */
      reason: RedirectRefusal | null;
      metadata: VerificationMetadata;
    }>;

export type VerificationFetchOptions = Readonly<{
  /**
   * Test seam. Resolves a name without a network, so the filtering can be
   * proven against addresses no test machine can own.
   */
  resolve?: AddressResolver;
  /**
   * Test seam, and the sharper one. Builds the `lookup` the socket uses,
   * from the record this attempt reports into; it defaults to the guarded
   * lookup, which is where the SSRF guarantee lives. A test overrides it to
   * reach a loopback server — the very thing the guarded lookup exists to
   * refuse — so the transport's bounds and redirects can be exercised against
   * a real server. Nothing in the application passes it, and a test asserts
   * the default is the guarded one.
   *
   * It takes the record rather than being a bare `lookup` so that a
   * composition — one host through the guarded lookup, another to a test
   * server — still reports its refusals where the failure code is read from.
   * A lookup that refuses without recording would land on
   * `CONNECTION_FAILED`, which would be a lie about why nothing connected.
   */
  lookup?: (record: LookupRecord) => LookupFunction;
  /**
   * Test seam. The ports the two schemes are fetched on, default 80 and 443.
   * A test server cannot bind those where the suite runs, and the transport's
   * own behaviour — redirects, bounds, encodings, statuses — is the part most
   * worth exercising against a real server rather than a mock. The port never
   * enters a URL, so redirect revalidation still refuses a ported hop.
   */
  ports?: VerificationFetchPorts;
}>;

/**
 * Fetch `https://<hostname>/`, falling back to `http://` once if the
 * connection or the TLS handshake failed (owner's decision, 2026-09-27): a
 * customer served over plain HTTP has the same disclosure obligation, and
 * refusing to look would record a failure that is really about their
 * certificate. Both attempts share one total-timeout budget, and the scheme
 * that answered is part of the record rather than an implementation detail.
 */
export async function fetchVerificationPage(
  hostname: string,
  options: VerificationFetchOptions = {},
): Promise<VerificationFetchResult> {
  const startedAt = Date.now();
  const deadline = startedAt + VERIFICATION_FETCH_BOUNDS.totalMs;
  const record = createLookupRecord();
  const lookup =
    options.lookup === undefined
      ? createGuardedLookup(record, options.resolve)
      : options.lookup(record);

  const ports = options.ports ?? DEFAULT_PORTS;

  let chain = await followChain(
    `https://${hostname}/`,
    deadline,
    lookup,
    record,
    ports,
  );
  let httpsFailed = false;
  if (!chain.ok && RETRY_OVER_HTTP.has(chain.code) && Date.now() < deadline) {
    httpsFailed = true;
    chain = await followChain(
      `http://${hostname}/`,
      deadline,
      lookup,
      record,
      ports,
    );
  }

  const metadata: VerificationMetadata = {
    scheme: chain.scheme,
    https_failed: httpsFailed,
    redirects: chain.redirects,
    final_host: chain.finalHost,
    duration_ms: Date.now() - startedAt,
    ...(chain.contentType === null ? {} : { content_type: chain.contentType }),
    ...(chain.ok ? { response_bytes: chain.body.length } : {}),
  };

  return chain.ok
    ? Object.freeze({
        ok: true as const,
        httpStatus: chain.httpStatus,
        body: chain.body,
        metadata,
      })
    : Object.freeze({
        ok: false as const,
        code: chain.code,
        httpStatus: chain.httpStatus,
        reason: chain.reason,
        metadata,
      });
}

type ChainResult = Readonly<{
  scheme: "https" | "http";
  redirects: number;
  finalHost: string;
  contentType: string | null;
}> &
  (
    | Readonly<{ ok: true; httpStatus: number; body: Buffer }>
    | Readonly<{
        ok: false;
        code: VerificationFailureCode;
        httpStatus: number | null;
        reason: RedirectRefusal | null;
      }>
  );

/**
 * One attempt, following redirects. Every hop is put through
 * `validateRedirectTarget` before it is requested, which is what README §17
 * means by revalidating a redirect target: a chain that ends at a private
 * address is refused before the last connection, not after it.
 */
async function followChain(
  start: string,
  deadline: number,
  lookup: LookupFunction,
  record: LookupRecord,
  ports: VerificationFetchPorts,
): Promise<ChainResult> {
  let url = new URL(start);
  const scheme = url.protocol === "https:" ? "https" : "http";
  let redirects = 0;

  for (;;) {
    const hop = await requestOnce(url, deadline, lookup, record, ports);
    const where = { scheme, redirects, finalHost: url.hostname } as const;

    if (hop.kind === "failure") {
      return {
        ...where,
        contentType: null,
        ok: false,
        code: hop.code,
        httpStatus: null,
        reason: null,
      };
    }

    if (hop.kind === "redirect") {
      if (redirects >= VERIFICATION_FETCH_BOUNDS.maxRedirects) {
        return {
          ...where,
          contentType: null,
          ok: false,
          code: "TOO_MANY_REDIRECTS",
          httpStatus: hop.status,
          reason: null,
        };
      }
      const decision = validateRedirectTarget(hop.location, url);
      if (!decision.ok) {
        return {
          ...where,
          contentType: null,
          ok: false,
          code: decision.code,
          httpStatus: hop.status,
          reason: decision.reason,
        };
      }
      url = decision.url;
      redirects += 1;
      continue;
    }

    const reached = { ...where, contentType: hop.contentType };
    // A status outside 2xx is the evidence; a code per class would multiply
    // §19 without saying anything the number does not.
    return hop.status < 200 || hop.status > 299
      ? {
          ...reached,
          ok: false,
          code: "HTTP_ERROR",
          httpStatus: hop.status,
          reason: null,
        }
      : { ...reached, ok: true, httpStatus: hop.status, body: hop.body };
  }
}

type HopOutcome =
  | Readonly<{
      kind: "response";
      status: number;
      contentType: string | null;
      body: Buffer;
    }>
  | Readonly<{ kind: "redirect"; status: number; location: string }>
  | Readonly<{ kind: "failure"; code: VerificationFailureCode }>;

/**
 * One request. The timers are separate on purpose: a connection that never
 * opened is `CONNECTION_TIMEOUT`, and one that opened and never finished is
 * `TOTAL_TIMEOUT`. The total timer runs against the whole attempt's deadline,
 * so a chain of slow hops cannot spend more than one budget between them.
 */
function requestOnce(
  url: URL,
  deadline: number,
  lookup: LookupFunction,
  record: LookupRecord,
  ports: VerificationFetchPorts,
): Promise<HopOutcome> {
  return new Promise((settle) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      settle({ kind: "failure", code: "TOTAL_TIMEOUT" });
      return;
    }

    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    let done = false;
    let abortedAs: VerificationFailureCode | null = null;
    let responseStarted = false;

    const options: RequestOptions & { autoSelectFamily?: boolean } = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: secure ? ports.https : ports.http,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml",
        // Ask for no encoding; handle the common ones anyway, because a CDN
        // that compresses regardless would otherwise hand TASK-024 bytes it
        // reads as "no widget", which is false evidence.
        "accept-encoding": "identity",
        "user-agent": userAgent(),
      },
      // A fresh connection every time. The global agent keeps sockets alive
      // and would reuse one, which would skip the guarded lookup on a later
      // request — the guarantee is per connection, so the connection is not
      // shared.
      agent: false,
      lookup,
      // Happy Eyeballs would ask the lookup for every address and race them,
      // so no row could say which address answered.
      autoSelectFamily: false,
    };

    const request = send(options);

    const totalTimer = setTimeout(() => {
      abortedAs = "TOTAL_TIMEOUT";
      request.destroy();
    }, remaining);
    // Only when there is a connect budget inside the remaining one. If the
    // deadline is the tighter of the two, the honest answer is that the total
    // budget ran out, not that the connection was slow.
    const connectTimer =
      remaining > VERIFICATION_FETCH_BOUNDS.connectMs
        ? setTimeout(() => {
            abortedAs = "CONNECTION_TIMEOUT";
            request.destroy();
          }, VERIFICATION_FETCH_BOUNDS.connectMs)
        : undefined;

    const finish = (outcome: HopOutcome) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      request.destroy();
      settle(outcome);
    };

    request.on("socket", (socket) => {
      socket.once(secure ? "secureConnect" : "connect", () => {
        clearTimeout(connectTimer);
      });
    });

    request.on("error", (error: Error) => {
      if (abortedAs !== null) {
        finish({ kind: "failure", code: abortedAs });
        return;
      }
      // The lookup's own record, not the socket error: `net` rewrites the
      // error it is given, and the difference between a name that does not
      // resolve and one that resolves into private space is evidence.
      if (record.refusal !== null) {
        finish({ kind: "failure", code: record.refusal });
        return;
      }
      finish({
        kind: "failure",
        code: transportFailure(error, responseStarted),
      });
    });

    request.on("response", (response) => {
      responseStarted = true;
      clearTimeout(connectTimer);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (
        REDIRECT_STATUSES.has(status) &&
        typeof location === "string" &&
        location.length > 0
      ) {
        finish({ kind: "redirect", status, location });
        return;
      }

      const contentType = headerValue(response.headers, "content-type");
      if (status < 200 || status > 299) {
        // Nothing is read: the status is the finding, and an error page is
        // still the customer's page.
        finish({ kind: "response", status, contentType, body: EMPTY_BODY });
        return;
      }

      const declared = Number(headerValue(response.headers, "content-length"));
      if (
        Number.isFinite(declared) &&
        declared > VERIFICATION_FETCH_BOUNDS.maxBodyBytes
      ) {
        finish({ kind: "failure", code: "RESPONSE_TOO_LARGE" });
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > VERIFICATION_FETCH_BOUNDS.maxBodyBytes) {
          // A refusal, never a truncation: inspecting a cut-off page would
          // report WIDGET_NOT_FOUND for a page that may well contain it.
          finish({ kind: "failure", code: "RESPONSE_TOO_LARGE" });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const decoded = decompress(
          Buffer.concat(chunks),
          headerValue(response.headers, "content-encoding"),
        );
        finish(
          decoded.ok
            ? { kind: "response", status, contentType, body: decoded.body }
            : { kind: "failure", code: decoded.code },
        );
      });
      response.on("error", (error: Error) => {
        finish({
          kind: "failure",
          code: abortedAs ?? transportFailure(error, responseStarted),
        });
      });
    });

    request.end();
  });
}

const EMPTY_BODY = Buffer.alloc(0);

/**
 * A response body as bytes. `maxOutputLength` is what makes a compression
 * bomb `RESPONSE_TOO_LARGE` rather than memory: the cap applies to what comes
 * out, not only to what came in.
 */
function decompress(
  body: Buffer,
  encoding: string | null,
):
  | Readonly<{ ok: true; body: Buffer }>
  | Readonly<{ ok: false; code: VerificationFailureCode }> {
  const name = (encoding ?? "").trim().toLowerCase();
  if (name === "" || name === "identity") {
    return { ok: true, body };
  }
  const limits = { maxOutputLength: VERIFICATION_FETCH_BOUNDS.maxBodyBytes };
  try {
    if (name === "gzip" || name === "x-gzip") {
      return { ok: true, body: gunzipSync(body, limits) };
    }
    if (name === "br") {
      return { ok: true, body: brotliDecompressSync(body, limits) };
    }
    if (name === "deflate") {
      // Some servers send raw deflate under this name.
      try {
        return { ok: true, body: inflateSync(body, limits) };
      } catch {
        return { ok: true, body: inflateRawSync(body, limits) };
      }
    }
  } catch (error) {
    return {
      ok: false,
      code: tooLarge(error) ? "RESPONSE_TOO_LARGE" : "UNKNOWN_ERROR",
    };
  }
  // An encoding we did not ask for and cannot read. UNKNOWN_ERROR is the
  // honest answer: we do not know what we were given.
  return { ok: false, code: "UNKNOWN_ERROR" };
}

function tooLarge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
  );
}

/**
 * What a socket error means. Nothing arrived, and the name resolved, so the
 * connection failed: refused, reset, unreachable, or rejected at TLS. Only an
 * error after a response began is `UNKNOWN_ERROR`, because then something did
 * arrive and we cannot say what went wrong with it.
 */
function transportFailure(
  error: Error,
  responseStarted: boolean,
): VerificationFailureCode {
  if (responseStarted) {
    return "UNKNOWN_ERROR";
  }
  const code = (error as { code?: string }).code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") {
    return "DNS_ERROR";
  }
  if (code === "ETIMEDOUT") {
    return "CONNECTION_TIMEOUT";
  }
  return "CONNECTION_FAILED";
}

/** A header as one value; Node gives an array for a few of them. */
function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name];
  if (typeof value === "string") {
    return value.slice(0, 256);
  }
  return Array.isArray(value) ? (value[0] ?? "").slice(0, 256) : null;
}

/**
 * Who is asking. A customer looking at their access log can tell what the
 * traffic is and allow it deliberately rather than by guessing, so the
 * verifier names itself and where to read about it.
 */
function userAgent(): string {
  return `Article50Verifier/1.0 (+${serverEnv().NEXT_PUBLIC_APP_URL})`;
}

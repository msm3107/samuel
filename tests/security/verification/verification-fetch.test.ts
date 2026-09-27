import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchVerificationPage } from "@/features/verification/fetch-page";
// The seam-taking module, which only `tests/` may import (PR #40 review,
// note 3). `fetchVerificationPage` above is the surface the application uses,
// and it takes a hostname and nothing else.
import {
  fetchPage,
  VERIFICATION_FETCH_BOUNDS,
  type VerificationFetchPorts,
} from "@/features/verification/fetch-page.internal";
import { VERIFICATION_METADATA_KEYS } from "@/features/verification/verification-check";
import {
  type AddressResolver,
  createGuardedLookup,
  type LookupRecord,
} from "@/lib/security/verification-lookup";

/**
 * README §37's SSRF requirement for the verifier's fetch (TASK-023), and the
 * bounds around it (PLAN Phase 7's exit criteria).
 *
 * Two halves, and the split is forced by the thing being tested. The SSRF
 * half uses the real guarded lookup with a fake resolver, because addresses
 * like 169.254.169.254 cannot be owned by a test machine. The transport half
 * overrides the lookup to reach a real loopback server — the very address the
 * guarded lookup exists to refuse — because redirects, size caps and
 * encodings are worth exercising against a real server rather than a mock.
 *
 * The first half proves the guard; the second proves what the guard is
 * guarding.
 */

const started: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** A real HTTP server on loopback, and the requests it saw. */
async function serve(handler: Handler) {
  const requests: { url: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  started.push({ close });
  return { port: (server.address() as AddressInfo).port, requests, close };
}

/** A port nothing listens on, so the HTTPS attempt fails at once. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) => {
    server.close(() => done());
  });
  return port;
}

/** Every name answers on loopback. Only a test may do this. */
const toLoopback: LookupFunction = (_hostname, options, callback) => {
  if (options.all === true) {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
    return;
  }
  callback(null, "127.0.0.1", 4);
};

/** A resolver that answers with these addresses for every name. */
function answers(...addresses: readonly string[]): AddressResolver {
  return (_hostname, _family, callback) => {
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
  };
}

describe("the verifier's fetch, against a blocked target", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["a private address", "192.168.1.10"],
    ["the cloud metadata address", "169.254.169.254"],
    ["AWS's IPv6 metadata address", "fd00:ec2::254"],
    ["Alibaba's metadata address", "100.100.100.200"],
    ["an IPv6 loopback", "::1"],
    ["an IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ])(
    "refuses a name that resolves to %s, and opens no socket",
    async (_label, address) => {
      // The ports point at a real, live server on loopback. If the guard
      // failed, the request would arrive — so "the server saw nothing" is a
      // claim about the guard and not about the port being wrong.
      const server = await serve((_request, response) => {
        response.end("<html><!-- article50 --></html>");
      });

      const result = await fetchPage("shop.example.com", {
        resolve: answers(address),
        ports: { http: server.port, https: server.port },
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe("PRIVATE_NETWORK_BLOCKED");
      expect(server.requests).toEqual([]);
    },
  );

  it("refuses when a rebinding answer hides a private address behind a public one", async () => {
    const server = await serve((_request, response) => response.end("ok"));

    // Only the private address is refused; the public one would be connected
    // to. Here both are private, so nothing is.
    const result = await fetchPage("shop.example.com", {
      resolve: answers("10.0.0.7", "127.0.0.1"),
      ports: { http: server.port, https: server.port },
    });

    expect(!result.ok && result.code).toBe("PRIVATE_NETWORK_BLOCKED");
    expect(server.requests).toEqual([]);
  });

  it("reports a resolver failure as DNS_ERROR, not as a blocked address", async () => {
    const result = await fetchPage("shop.example.com", {
      resolve: (_hostname, _family, callback) => {
        callback(new Error("getaddrinfo ENOTFOUND"), []);
      },
      ports: { http: 1, https: 1 },
    });

    expect(!result.ok && result.code).toBe("DNS_ERROR");
  });

  it("refuses a redirect that leaves the public internet, through the chain", async () => {
    // A name that no reserved-name rule catches (`intranet` is not a reserved
    // top-level name, by TASK-012's own decision), so the hop passes the
    // validator and has to be stopped by the address rules at resolution.
    // One lookup for the test server, the guarded one for the hop.
    const server = await serve((_request, response) => {
      response.writeHead(302, { location: "http://db.intranet/" });
      response.end();
    });
    const https = await closedPort();

    const result = await fetchPage("shop.example.com", {
      ports: { http: server.port, https },
      lookup: (record: LookupRecord) => {
        const guarded = createGuardedLookup(record, answers("10.1.2.3"));
        return (hostname, options, callback) =>
          hostname === "db.intranet"
            ? guarded(hostname, options, callback)
            : toLoopback(hostname, options, callback);
      },
    });

    expect(!result.ok && result.code).toBe("PRIVATE_NETWORK_BLOCKED");
    expect(result.metadata.redirects).toBe(1);
  });

  it("refuses a redirect to a loopback address before connecting to it", async () => {
    const server = await serve((request, response) => {
      if (request.url === "/") {
        response.writeHead(301, { location: "http://127.0.0.1/" });
        response.end();
        return;
      }
      response.end("reached");
    });
    const https = await closedPort();

    const result = await fetchPage("shop.example.com", {
      ports: { http: server.port, https },
      lookup: () => toLoopback,
    });

    expect(!result.ok && result.code).toBe("PRIVATE_NETWORK_BLOCKED");
    expect(!result.ok && result.reason).toBe("PRIVATE_NETWORK_BLOCKED");
    // The hop was refused by the validator, so only the first request ran.
    expect(server.requests.map((entry) => entry.url)).toEqual(["/"]);
  });

  it("refuses a redirect to a non-default port and to a public IP literal", async () => {
    const https = await closedPort();
    for (const [location, reason] of [
      ["http://shop.example.com:8443/", "PORT_NOT_ALLOWED"],
      ["http://93.184.216.34/", "IP_ADDRESS_NOT_ALLOWED"],
      ["ftp://files.example.com/", "UNSUPPORTED_SCHEME"],
    ] as const) {
      const server = await serve((_request, response) => {
        response.writeHead(302, { location });
        response.end();
      });

      const result = await fetchPage("shop.example.com", {
        ports: { http: server.port, https },
        lookup: () => toLoopback,
      });

      expect(!result.ok && result.code).toBe("REDIRECT_BLOCKED");
      expect(!result.ok && result.reason).toBe(reason);
    }
  });
});

describe("the verifier's fetch, against a real server", () => {
  /** Every case here starts with an HTTPS attempt that is refused at once. */
  async function ports(httpPort: number): Promise<VerificationFetchPorts> {
    return { http: httpPort, https: await closedPort() };
  }

  it("returns the body, and records how it was fetched", async () => {
    const page = "<html><head><script src=/widget.js></script></head></html>";
    const server = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page);
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.httpStatus).toBe(200);
    expect(result.ok && result.body.toString("utf8")).toBe(page);
    expect(result.metadata).toMatchObject({
      // HTTPS was tried first and refused, so this is the fallback the owner
      // chose on 2026-09-27, and the row says so.
      scheme: "http",
      https_failed: true,
      redirects: 0,
      final_host: "shop.example.com",
      response_bytes: page.length,
      content_type: "text/html; charset=utf-8",
    });
    expect(result.metadata.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("names itself, and asks for no encoding", async () => {
    const server = await serve((_request, response) => response.end("ok"));

    await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    const headers = server.requests[0]?.headers ?? {};
    // A customer reading their access log can tell what the traffic is.
    expect(headers["user-agent"]).toMatch(/^Article50Verifier\/1\.0 \(\+http/);
    expect(headers["accept-encoding"]).toBe("identity");
    // Node adds the port when it is not the scheme's default, which only a
    // test ever sees; the name is what matters.
    expect(headers["host"]).toMatch(/^shop\.example\.com/);
  });

  it("follows a chain of redirects and reports where it ended", async () => {
    const first = await serve((request, response) => {
      if (request.url === "/") {
        response.writeHead(301, { location: "/en/" });
        response.end();
        return;
      }
      if (request.url === "/en/") {
        response.writeHead(302, { location: "http://www.example.com/home" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>done</html>");
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(first.port),
      lookup: () => toLoopback,
    });

    expect(result.ok).toBe(true);
    expect(result.metadata.redirects).toBe(2);
    // A chain may legitimately change host, and the row says which one
    // answered rather than which one was asked.
    expect(result.metadata.final_host).toBe("www.example.com");
  });

  it("stops at the redirect bound, with its own code", async () => {
    let hop = 0;
    const server = await serve((_request, response) => {
      hop += 1;
      response.writeHead(302, { location: `/hop-${hop}` });
      response.end();
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(!result.ok && result.code).toBe("TOO_MANY_REDIRECTS");
    expect(result.metadata.redirects).toBe(
      VERIFICATION_FETCH_BOUNDS.maxRedirects,
    );
    // Five hops followed, and the sixth response is the one that was refused.
    expect(server.requests).toHaveLength(
      VERIFICATION_FETCH_BOUNDS.maxRedirects + 1,
    );
  });

  it("refuses an oversized body by its declared length, before reading it", async () => {
    let bytesSent = 0;
    const server = await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-length": String(VERIFICATION_FETCH_BOUNDS.maxBodyBytes + 1),
      });
      const chunk = "a".repeat(1024);
      bytesSent += chunk.length;
      response.write(chunk);
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(!result.ok && result.code).toBe("RESPONSE_TOO_LARGE");
    // Refused on the header: nothing like the whole body was read.
    expect(bytesSent).toBeLessThan(VERIFICATION_FETCH_BOUNDS.maxBodyBytes);
  });

  it("refuses an oversized body that declared no length", async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      // Chunked, so there is no Content-Length to check.
      for (
        let written = 0;
        written <= VERIFICATION_FETCH_BOUNDS.maxBodyBytes;
      ) {
        const chunk = "b".repeat(64 * 1024);
        response.write(chunk);
        written += chunk.length;
      }
      response.end();
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    // A refusal, never a truncation: a cut-off page would be reported as
    // WIDGET_NOT_FOUND, which is false evidence.
    expect(!result.ok && result.code).toBe("RESPONSE_TOO_LARGE");
    expect(result.ok).toBe(false);
  });

  it("accepts a body exactly at the cap", async () => {
    const body = "c".repeat(VERIFICATION_FETCH_BOUNDS.maxBodyBytes);
    const server = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(body);
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(result.ok).toBe(true);
    expect(result.metadata.response_bytes).toBe(
      VERIFICATION_FETCH_BOUNDS.maxBodyBytes,
    );
  });

  it.each([
    [404, "HTTP_ERROR"],
    [410, "HTTP_ERROR"],
    [500, "HTTP_ERROR"],
    [503, "HTTP_ERROR"],
  ])("reports %i as %s, with the status", async (status, code) => {
    const server = await serve((_request, response) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end("<html>sorry</html>");
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(!result.ok && result.code).toBe(code);
    expect(!result.ok && result.httpStatus).toBe(status);
  });

  it("reports a 3xx with no Location as an HTTP error", async () => {
    const server = await serve((_request, response) => {
      response.writeHead(302);
      response.end();
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(!result.ok && result.code).toBe("HTTP_ERROR");
    expect(!result.ok && result.httpStatus).toBe(302);
  });

  it("reads a gzipped body a server sent anyway", async () => {
    const page = "<html>gzipped</html>";
    const server = await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      response.end(gzipSync(Buffer.from(page, "utf8")));
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    // Identity was asked for. A CDN that compresses regardless would
    // otherwise hand TASK-024 bytes it reads as "no widget".
    expect(result.ok && result.body.toString("utf8")).toBe(page);
    expect(result.metadata.response_bytes).toBe(page.length);
  });

  it("refuses a compression bomb as an oversized response", async () => {
    const bomb = gzipSync(
      Buffer.alloc(VERIFICATION_FETCH_BOUNDS.maxBodyBytes * 4, 0x61),
    );
    expect(bomb.length).toBeLessThan(VERIFICATION_FETCH_BOUNDS.maxBodyBytes);
    const server = await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      response.end(bomb);
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    // The cap is on what comes out, not only on what came in.
    expect(!result.ok && result.code).toBe("RESPONSE_TOO_LARGE");
  });

  it("reports an encoding it cannot read as unknown, not as absence", async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "zstd",
      });
      response.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    // Not WIDGET_NOT_FOUND: we do not know what we were given.
    expect(!result.ok && result.code).toBe("UNKNOWN_ERROR");
  });

  it("keeps page content out of the metadata", async () => {
    const secret = "visitor-email-someone@example.com";
    const server = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<html><p>${secret}</p></html>`);
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    // The planted string proves this is not vacuous: it is in the body the
    // fetch returned, and nowhere in what would be stored.
    expect(result.ok && result.body.toString("utf8")).toContain(secret);
    expect(JSON.stringify(result.metadata)).not.toContain(secret);
    for (const key of Object.keys(result.metadata)) {
      expect(VERIFICATION_METADATA_KEYS).toContain(key);
    }
  });

  it(
    "gives up on a server that accepts and never answers, on the total bound",
    async () => {
      const server = await serve(() => {
        // Accept the request and answer nothing at all.
      });
      const startedAt = Date.now();

      const result = await fetchPage("shop.example.com", {
        ports: await ports(server.port),
        lookup: () => toLoopback,
      });

      expect(!result.ok && result.code).toBe("TOTAL_TIMEOUT");
      // The bound is real, not a mocked clock: this waited for it.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        VERIFICATION_FETCH_BOUNDS.totalMs - 500,
      );
    },
    VERIFICATION_FETCH_BOUNDS.totalMs + 15_000,
  );

  it(
    "gives up on a connection that never opens, on its own bound",
    async () => {
      // A lookup that never answers: no socket is ever connected, so what is
      // left is the connect bound, and it has its own code rather than
      // sharing the total one.
      const result = await fetchPage("shop.example.com", {
        ports: { http: 1, https: 1 },
        lookup: () => () => {
          /* never calls back */
        },
      });

      expect(!result.ok && result.code).toBe("CONNECTION_TIMEOUT");
    },
    VERIFICATION_FETCH_BOUNDS.totalMs + 15_000,
  );
});

describe("what a failed check still records", () => {
  async function ports(httpPort: number): Promise<VerificationFetchPorts> {
    return { http: httpPort, https: await closedPort() };
  }

  it("keeps the status and the type on an oversized response", async () => {
    // PR #40 review, note 1: the server answered, so the row knows what it
    // answered with. Support can tell a 200 of 4 MB of HTML from something
    // stranger, instead of asking the customer to guess.
    const server = await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(VERIFICATION_FETCH_BOUNDS.maxBodyBytes + 1),
      });
      response.write("a");
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(!result.ok && result.code).toBe("RESPONSE_TOO_LARGE");
    expect(!result.ok && result.httpStatus).toBe(200);
    expect(result.metadata.content_type).toBe("text/html; charset=utf-8");
  });

  it("keeps them on an encoding it could not read", async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "zstd",
      });
      response.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
    });

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(!result.ok && result.code).toBe("UNKNOWN_ERROR");
    expect(!result.ok && result.httpStatus).toBe(200);
  });

  it("records nothing about a response that never arrived", async () => {
    const result = await fetchPage("shop.example.com", {
      resolve: answers("127.0.0.1"),
      ports: { http: 1, https: 1 },
    });

    // The asymmetry is deliberate: http_status means "if we got one".
    expect(!result.ok && result.httpStatus).toBeNull();
    expect(result.metadata.content_type).toBeUndefined();
  });

  it("says which redirect rule refused a hop", async () => {
    const https = await closedPort();
    for (const [location, reason] of [
      ["ftp://files.example.com/", "UNSUPPORTED_SCHEME"],
      ["http://shop.example.com:8443/", "PORT_NOT_ALLOWED"],
      ["http://user:pw@shop.example.com/", "EMBEDDED_CREDENTIALS"],
      ["http://93.184.216.34/", "IP_ADDRESS_NOT_ALLOWED"],
    ] as const) {
      const server = await serve((_request, response) => {
        response.writeHead(302, { location });
        response.end();
      });

      const result = await fetchPage("shop.example.com", {
        ports: { http: server.port, https },
        lookup: () => toLoopback,
      });

      // One stored code, six causes, six different fixes (PR #40 review,
      // note 2). The stored code stays REDIRECT_BLOCKED; the detail is in the
      // metadata, where §19 does not reach.
      expect(!result.ok && result.code).toBe("REDIRECT_BLOCKED");
      expect(result.metadata.redirect_reason).toBe(reason);
      expect(VERIFICATION_METADATA_KEYS).toContain("redirect_reason");
    }
  });

  it("carries no redirect reason when no redirect was refused", async () => {
    const server = await serve((_request, response) => response.end("ok"));

    const result = await fetchPage("shop.example.com", {
      ports: await ports(server.port),
      lookup: () => toLoopback,
    });

    expect(result.metadata.redirect_reason).toBeUndefined();
  });
});

describe("the public surface", () => {
  it("takes a hostname and nothing else", () => {
    // PR #40 review, note 3. The seams are not reachable from application
    // code: the ESLint rule refuses the import, and this is the shape that
    // makes the rule meaningful rather than decorative.
    expect(fetchVerificationPage.length).toBe(1);
  });

  it("rejects rather than inventing evidence for a hostname it cannot parse", async () => {
    // Owner's decision, 2026-09-27 (note 4): both throws are our bug, not the
    // customer's. A failure row would say their site did not comply.
    // TASK-025 catches per deployment and logs which hostname it was.
    await expect(fetchVerificationPage("not a hostname")).rejects.toThrow();
  });
});

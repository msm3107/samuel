import { describe, expect, it } from "vitest";

import { createLogger, type Logger } from "@/lib/logging/logger";

const ACCESS_TOKEN = "sbp-access-token-value";
const SERVICE_KEY = "service-role-key-value";

function captureLogLine(write: (logger: Logger) => void): string {
  const lines: string[] = [];
  const logger = createLogger({
    write(chunk: string) {
      lines.push(chunk);
    },
  });

  write(logger);

  const line = lines[0];
  expect(line, "expected exactly one log line").toBeDefined();

  return line as string;
}

describe("log redaction", () => {
  it("redacts credentials passed at the top level of a record", () => {
    const line = captureLogLine((logger) => {
      logger.error(
        { accessToken: ACCESS_TOKEN, secret: SERVICE_KEY },
        "verification failed",
      );
    });

    const record = JSON.parse(line) as Record<string, unknown>;

    expect(record.accessToken).toBe("[redacted]");
    expect(record.secret).toBe("[redacted]");
    expect(line).not.toContain(ACCESS_TOKEN);
    expect(line).not.toContain(SERVICE_KEY);
  });

  it("redacts authorization and cookie headers", () => {
    const line = captureLogLine((logger) => {
      logger.error(
        {
          req: {
            headers: { authorization: "Bearer abc", cookie: "session=xyz" },
          },
        },
        "request rejected",
      );
    });

    expect(line).not.toContain("Bearer abc");
    expect(line).not.toContain("session=xyz");
  });

  it("redacts credentials nested one level inside a record", () => {
    const line = captureLogLine((logger) => {
      logger.error({ stripe: { apiKey: SERVICE_KEY } }, "billing sync failed");
    });

    expect(line).not.toContain(SERVICE_KEY);
  });

  it("keeps non-sensitive correlation fields intact", () => {
    const line = captureLogLine((logger) => {
      logger.error(
        { organizationId: "org_1", deploymentId: "dep_2" },
        "deployment verification completed",
      );
    });

    const record = JSON.parse(line) as Record<string, unknown>;

    expect(record.organizationId).toBe("org_1");
    expect(record.deploymentId).toBe("dep_2");
    expect(record.msg).toBe("deployment verification completed");
  });
});

import pino, { type DestinationStream, type Logger } from "pino";

import { serverEnv } from "@/lib/env/server-env";

/**
 * Paths scrubbed before a record is written. Rule 24 forbids these values in
 * logs; redacting centrally means a careless call site cannot leak them.
 */
export const REDACTED_PATHS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "apiKey",
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "req.headers.authorization",
  "req.headers.cookie",
  "stripeSignature",
  "card",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.apiKey",
] as const;

export const REDACTION_CENSOR = "[redacted]";

/**
 * Takes an explicit destination so redaction can be asserted in tests rather
 * than assumed.
 */
export function createLogger(destination?: DestinationStream): Logger {
  const options = {
    level: serverEnv().LOG_LEVEL,
    redact: { paths: [...REDACTED_PATHS], censor: REDACTION_CENSOR },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };

  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();

export type { Logger };

/**
 * Reads mail delivered by local Supabase to Mailpit, so a test can follow the
 * magic link a person would receive.
 */

function mailpitUrl() {
  // Test-harness configuration set by scripts/local-env.mjs, not application
  // configuration, so it is not part of lib/env's schema.
  // eslint-disable-next-line no-restricted-properties
  const url = process.env.LOCAL_MAILPIT_URL;
  if (!url) {
    throw new Error(
      "LOCAL_MAILPIT_URL is not set; run through `pnpm test:supabase`.",
    );
  }
  return url;
}

type MailpitSummary = { ID: string; To: { Address: string }[] };

async function messagesTo(address: string): Promise<MailpitSummary[]> {
  const query = encodeURIComponent(`to:"${address}"`);
  const response = await fetch(`${mailpitUrl()}/api/v1/search?query=${query}`);
  if (!response.ok) {
    throw new Error(`Mailpit search failed: ${response.status}`);
  }
  const body = (await response.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
}

/**
 * Waits for the newest email to `address` and returns the Supabase verify
 * link inside it — the link a person clicks.
 */
export async function waitForMagicLink(
  address: string,
  { timeoutMs = 15_000 } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const [newest] = await messagesTo(address);
    if (newest) {
      const response = await fetch(
        `${mailpitUrl()}/api/v1/message/${newest.ID}`,
      );
      const message = (await response.json()) as {
        HTML?: string;
        Text?: string;
      };
      const body = `${message.HTML ?? ""} ${message.Text ?? ""}`;
      const link = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(
        body,
      )?.[0];
      if (link) {
        return link.replaceAll("&amp;", "&");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No magic link arrived for ${address} within ${timeoutMs}ms`);
}

export async function countMessagesTo(address: string) {
  return (await messagesTo(address)).length;
}

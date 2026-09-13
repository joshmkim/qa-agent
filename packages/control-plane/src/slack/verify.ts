import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack rejects requests older than this; we do too, to block replays. */
const MAX_SKEW_SECONDS = 5 * 60;

/**
 * Slack signs `v0:{timestamp}:{rawBody}` with the app's signing secret.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(now / 1000 - timestamp) > MAX_SKEW_SECONDS) return false;

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestampHeader}:${rawBody}`)
    .digest("hex")}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

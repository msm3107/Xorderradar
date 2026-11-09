import type { FeedbackVerdict } from "../infrastructure/db/schema.js";

/**
 * The web links put into e-mails and printed by `access:link` (D-026). The
 * base is PUBLIC_BASE_URL as validated by the config (an origin, no trailing
 * slash); the token is a base64url secret, so it needs no encoding. A link
 * holds a secret: it is never logged.
 */

/** Login link: GET shows a confirmation page, its form POSTs the token. */
export function loginUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/dostep/${token}`;
}

/** One-click unsubscribe link (RFC 8058): GET confirms, POST unsubscribes. */
export function unsubscribeUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/wypis/${token}`;
}

/** Confirmation of a new address (D-031): GET shows a button, its form POSTs. */
export function emailConfirmUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/potwierdz-email/${token}`;
}

/** The verdict words of a rating link's path (PR-12, D-032), Polish like the routes. */
const VERDICT_WORDS = { relevant: "trafne", not_relevant: "nietrafne" } as const;

/** The path word of a verdict: `trafne` or `nietrafne`. */
export function verdictWord(verdict: FeedbackVerdict): string {
  return VERDICT_WORDS[verdict];
}

/** The verdict of a path or form word; null for anything outside the allowlist. */
export function parseVerdictWord(word: string): FeedbackVerdict | null {
  if (word === VERDICT_WORDS.relevant) return "relevant";
  if (word === VERDICT_WORDS.not_relevant) return "not_relevant";
  return null;
}

/**
 * Rating link of one offer in a digest (PR-12, D-032): GET shows a button,
 * its form POSTs the rating. The offer id is a uuid, safe in a path.
 */
export function feedbackUrl(
  publicBaseUrl: string,
  token: string,
  opportunityId: string,
  verdict: FeedbackVerdict,
): string {
  return `${publicBaseUrl}/ocena/${token}/${opportunityId}/${verdictWord(verdict)}`;
}

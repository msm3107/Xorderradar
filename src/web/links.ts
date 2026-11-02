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

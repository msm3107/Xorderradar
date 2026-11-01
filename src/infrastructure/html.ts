const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/**
 * Escapes text for an HTML text node or a double-quoted attribute value
 * (docs/SECURITY.md §10). Shared by the digest e-mail and the web pages: every
 * interpolated value goes through it, attribute values included.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => HTML_ESCAPES[char] ?? char);
}

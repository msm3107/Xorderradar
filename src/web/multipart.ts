/**
 * A minimal, strict reader of `multipart/form-data` (RFC 7578, framing from
 * RFC 2046 §5.1.1) for exactly one use: the RFC 8058 one-click unsubscribe
 * POST, whose body a mail provider SHOULD send as multipart (RFC 8058 §3.2).
 * No dependency: the body is at most 8 KB and only one short field matters.
 * Everything is plain index scanning (`indexOf`, `startsWith`) — no regex
 * runs over the body — and anything that does not parse cleanly is refused.
 */

/** RFC 2046 `bcharsnospace`; `bchars` adds the space. */
const BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;
/** RFC 7230 `token` characters (parameter names and unquoted values). */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const CRLF = "\r\n";

interface HeaderValue {
  /** The value before the first `;`, lower-cased (a media or disposition type). */
  readonly type: string;
  /** Parameters by lower-cased name; values as given (quotes and escapes removed). */
  readonly params: ReadonlyMap<string, string>;
}

/**
 * Parses `type; name=value; name="quoted value"`. null when malformed: an
 * empty type, a parameter without `=`, a name or unquoted value that is not a
 * token, an unterminated quoted string, text after a quoted string, or a
 * parameter given twice.
 */
export function parseHeaderValue(value: string): HeaderValue | null {
  const semicolon = value.indexOf(";");
  const type = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  if (type === "") return null;
  const params = new Map<string, string>();
  let pos = semicolon === -1 ? value.length : semicolon + 1;
  while (pos < value.length) {
    const equals = value.indexOf("=", pos);
    if (equals === -1) return null;
    const name = value.slice(pos, equals).trim().toLowerCase();
    if (!TOKEN_PATTERN.test(name) || params.has(name)) return null;
    pos = equals + 1;
    while (value[pos] === " " || value[pos] === "\t") pos++;
    let paramValue = "";
    if (value[pos] === '"') {
      pos++;
      let closed = false;
      while (pos < value.length) {
        const char = value.charAt(pos);
        if (char === "\\" && pos + 1 < value.length) {
          paramValue += value.charAt(pos + 1);
          pos += 2;
        } else if (char === '"') {
          closed = true;
          pos++;
          break;
        } else {
          paramValue += char;
          pos++;
        }
      }
      if (!closed) return null;
      while (value[pos] === " " || value[pos] === "\t") pos++;
      if (pos < value.length && value[pos] !== ";") return null;
    } else {
      const next = value.indexOf(";", pos);
      const end = next === -1 ? value.length : next;
      paramValue = value.slice(pos, end).trim();
      if (!TOKEN_PATTERN.test(paramValue)) return null;
      pos = end;
    }
    params.set(name, paramValue);
    pos++; // past the `;` (or the end)
  }
  return { type, params };
}

/**
 * For a `multipart/form-data` Content-Type: its boundary, or `boundary: null`
 * when the parameters do not parse or the boundary is missing or not valid
 * under RFC 2046 (1–70 characters of the allowed set, not ending in a space;
 * it may be quoted). null when the type is anything else.
 */
export function multipartBoundary(
  header: string | undefined,
): { readonly boundary: string | null } | null {
  if (header === undefined) return null;
  const type = header.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "multipart/form-data") return null;
  const boundary = parseHeaderValue(header)?.params.get("boundary");
  return { boundary: boundary !== undefined && BOUNDARY_PATTERN.test(boundary) ? boundary : null };
}

/**
 * The values of every part named `field` in a multipart/form-data body, in
 * order (the caller decides what a missing or repeated field means); parts
 * with other names are skipped. null when the body is not well-formed:
 * no delimiter line, a part that does not end in a delimiter, no close
 * delimiter, a part without headers ending in an empty line, a header line
 * without a colon or folded, or a part without exactly one valid
 * `Content-Disposition: form-data` with a `name`. The preamble before the
 * first delimiter and the epilogue after the close delimiter are ignored
 * (RFC 2046). The body is read as Latin-1, byte for byte, so binary parts
 * cannot fail decoding; the field value is compared by the caller.
 */
export function multipartFieldValues(
  body: Buffer,
  boundary: string,
  field: string,
): string[] | null {
  // A leading CRLF lets a delimiter on the very first line match like the others.
  const text = CRLF + body.toString("latin1");
  const delimiter = `${CRLF}--${boundary}`;
  let pos = text.indexOf(delimiter);
  if (pos === -1) return null;
  const values: string[] = [];
  for (;;) {
    pos += delimiter.length;
    if (text.startsWith("--", pos)) return values; // close delimiter
    // RFC 2046 allows linear whitespace (transport padding) after a delimiter.
    while (text[pos] === " " || text[pos] === "\t") pos++;
    if (!text.startsWith(CRLF, pos)) return null;
    const start = pos + CRLF.length;
    const end = text.indexOf(delimiter, start);
    if (end === -1) return null;
    const part = readPart(text.slice(start, end));
    if (part === null) return null;
    if (part.name === field) values.push(part.content);
    pos = end;
  }
}

/** One part: its form field name and content, or null when malformed. */
function readPart(part: string): { name: string; content: string } | null {
  let headerText: string;
  let content: string;
  if (part.startsWith(CRLF)) {
    headerText = "";
    content = part.slice(CRLF.length);
  } else {
    const headerEnd = part.indexOf(CRLF + CRLF);
    if (headerEnd === -1) return null;
    headerText = part.slice(0, headerEnd);
    content = part.slice(headerEnd + 2 * CRLF.length);
  }
  let disposition: HeaderValue | null = null;
  for (const line of headerText === "" ? [] : headerText.split(CRLF)) {
    const colon = line.indexOf(":");
    // Obsolete line folding (a line starting with whitespace) is refused too.
    if (colon <= 0 || line.startsWith(" ") || line.startsWith("\t")) return null;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-disposition") continue;
    if (disposition !== null) return null;
    disposition = parseHeaderValue(line.slice(colon + 1));
    if (disposition === null) return null;
  }
  if (disposition?.type !== "form-data") return null;
  const name = disposition.params.get("name");
  if (name === undefined) return null;
  return { name, content };
}

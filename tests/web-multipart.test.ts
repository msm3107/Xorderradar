import { describe, expect, it } from "vitest";
import { multipartBoundary, multipartFieldValues, parseHeaderValue } from "../src/web/multipart.js";

/*
 * The minimal multipart/form-data reader of the RFC 8058 one-click POST
 * (PR-06A). Bodies are built with explicit CRLFs; the boundary of the RFC 8058
 * §8.3 example is reused where it fits.
 */

const RFC_BOUNDARY = "---FormBoundaryjWmhtjORrn";

/** A body from raw lines, joined with CRLF. */
function lines(...parts: string[]): Buffer {
  return Buffer.from(parts.join("\r\n"), "latin1");
}

/** A well-formed body: one part per [name, value], with the close delimiter. */
function body(boundary: string, fields: readonly (readonly [string, string])[]): Buffer {
  const parts = fields.flatMap(([name, value]) => [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${name}"`,
    "",
    value,
  ]);
  return lines(...parts, `--${boundary}--`, "");
}

describe("parseHeaderValue", () => {
  it("reads the type and parameters, token or quoted", () => {
    const parsed = parseHeaderValue(' Form-Data ; name="a \\"b\\";c" ;filename*=x');
    expect(parsed?.type).toBe("form-data");
    expect(Object.fromEntries(parsed?.params ?? [])).toEqual({
      name: 'a "b";c',
      "filename*": "x",
    });
  });

  it.each([
    [""],
    ["; name=a"],
    ["form-data; name"],
    ["form-data; name=a; name=b"],
    ["form-data; NAME=a; name=b"],
    ['form-data; name="a'],
    ['form-data; name="a"b'],
    ["form-data; name=a b"],
    ["form-data; na me=a"],
    ["form-data; =a"],
  ])("refuses %j", (value) => {
    expect(parseHeaderValue(value)).toBeNull();
  });
});

describe("multipartBoundary", () => {
  it.each([
    [`multipart/form-data; boundary=${RFC_BOUNDARY}`, RFC_BOUNDARY],
    ['Multipart/Form-Data; boundary="with space and :?=/"', "with space and :?=/"],
    ["multipart/form-data;boundary=b;charset=utf-8", "b"],
    [`multipart/form-data; boundary=${"a".repeat(70)}`, "a".repeat(70)],
  ])("reads the boundary of %j", (header, boundary) => {
    expect(multipartBoundary(header)).toEqual({ boundary });
  });

  it.each([
    ["multipart/form-data"],
    ["multipart/form-data; charset=utf-8"],
    [`multipart/form-data; boundary=${"a".repeat(71)}`],
    ['multipart/form-data; boundary=""'],
    ['multipart/form-data; boundary="ends with space "'],
    ['multipart/form-data; boundary="semi;colon"'],
    ['multipart/form-data; boundary="quote\\"d"'],
    ['multipart/form-data; boundary="unterminated'],
    ["multipart/form-data; boundary=a; boundary=b"],
    ["multipart/form-data; boundary"],
  ])("gives no boundary (a 400) for %j", (header) => {
    expect(multipartBoundary(header)).toEqual({ boundary: null });
  });

  it.each([
    [undefined],
    ["application/x-www-form-urlencoded"],
    ["multipart/mixed; boundary=b"],
    ["text/plain; boundary=b"],
  ])("is not multipart/form-data: %j", (header) => {
    expect(multipartBoundary(header)).toBeNull();
  });
});

describe("multipartFieldValues", () => {
  it("reads the RFC 8058 §8.3 body (with the RFC 2046 `--` before the boundary)", () => {
    const rfc = lines(
      `--${RFC_BOUNDARY}`,
      'Content-Disposition: form-data; name="List-Unsubscribe"',
      "",
      "One-Click",
      `--${RFC_BOUNDARY}--`,
    );
    expect(multipartFieldValues(rfc, RFC_BOUNDARY, "List-Unsubscribe")).toEqual(["One-Click"]);
  });

  it("refuses the §8.3 lines taken literally, whose delimiter lacks the `--` prefix", () => {
    // RFC 2046 §5.1.1: a delimiter line is "--" + boundary. The example in
    // RFC 8058 §8.3 prints the boundary alone, so it has no delimiter at all.
    const literal = lines(
      RFC_BOUNDARY,
      'Content-Disposition: form-data; name="List-Unsubscribe"',
      "",
      "One-Click",
      `${RFC_BOUNDARY}--`,
    );
    expect(multipartFieldValues(literal, RFC_BOUNDARY, "List-Unsubscribe")).toBeNull();
  });

  it("ignores other parts, the preamble, the epilogue and transport padding", () => {
    const text = lines(
      "preamble",
      "--b \t",
      'Content-Disposition: form-data; name="other"; filename="x.bin"',
      "Content-Type: application/octet-stream",
      "",
      "\u0000ÿ\r\n--not-the-boundary",
      "--b",
      'content-disposition: FORM-DATA; name="List-Unsubscribe"',
      "Content-Type: text/plain",
      "",
      "One-Click",
      "--b--",
      "epilogue",
    );
    expect(multipartFieldValues(text, "b", "List-Unsubscribe")).toEqual(["One-Click"]);
  });

  it("returns every value of the field, or none", () => {
    const twice = body("b", [
      ["List-Unsubscribe", "One-Click"],
      ["List-Unsubscribe", "One-Click"],
    ]);
    expect(multipartFieldValues(twice, "b", "List-Unsubscribe")).toEqual([
      "One-Click",
      "One-Click",
    ]);
    const other = body("b", [["list-unsubscribe", "One-Click"]]);
    expect(multipartFieldValues(other, "b", "List-Unsubscribe")).toEqual([]);
    expect(multipartFieldValues(lines("--b--"), "b", "List-Unsubscribe")).toEqual([]);
  });

  it("keeps the value exactly, without the framing CRLFs", () => {
    const text = body("b", [["List-Unsubscribe", "One-Click\r\n"]]);
    expect(multipartFieldValues(text, "b", "List-Unsubscribe")).toEqual(["One-Click\r\n"]);
    const empty = body("b", [["List-Unsubscribe", ""]]);
    expect(multipartFieldValues(empty, "b", "List-Unsubscribe")).toEqual([""]);
  });

  it.each([
    ["no delimiter at all", lines("List-Unsubscribe=One-Click")],
    [
      "another boundary",
      lines("--c", 'Content-Disposition: form-data; name="List-Unsubscribe"', "", "One-Click"),
    ],
    [
      "no close delimiter",
      lines("--b", 'Content-Disposition: form-data; name="List-Unsubscribe"', "", "One-Click"),
    ],
    [
      "a delimiter followed by text",
      lines("--bx", 'Content-Disposition: form-data; name="x"', "", "1", "--b--"),
    ],
    ["no empty line after the headers", lines("--b", 'Content-Disposition: form-data; name="x"')],
    [
      "a part without Content-Disposition",
      lines("--b", "Content-Type: text/plain", "", "1", "--b--"),
    ],
    ["a part without headers", lines("--b", "", "1", "--b--")],
    [
      "a disposition other than form-data",
      lines("--b", 'Content-Disposition: attachment; name="x"', "", "1", "--b--"),
    ],
    [
      "a disposition without a name",
      lines("--b", "Content-Disposition: form-data", "", "1", "--b--"),
    ],
    [
      "two Content-Disposition headers",
      lines(
        "--b",
        'Content-Disposition: form-data; name="x"',
        'Content-Disposition: form-data; name="List-Unsubscribe"',
        "",
        "One-Click",
        "--b--",
      ),
    ],
    [
      "a header line without a colon",
      lines("--b", 'Content-Disposition: form-data; name="x"', "junk", "", "1", "--b--"),
    ],
    [
      "a folded header line",
      lines("--b", "Content-Disposition: form-data;", ' name="x"', "", "1", "--b--"),
    ],
    [
      "a malformed disposition",
      lines("--b", 'Content-Disposition: form-data; name="x', "", "1", "--b--"),
    ],
  ])("refuses a body with %s", (_label, text) => {
    expect(multipartFieldValues(text, "b", "List-Unsubscribe")).toBeNull();
  });

  it("stays fast on a hostile 8 KB body", () => {
    const hostile = Buffer.from(`--b\r\n${"\r\n--b ".repeat(1600)}`, "latin1");
    const started = performance.now();
    expect(multipartFieldValues(hostile, "b", "List-Unsubscribe")).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

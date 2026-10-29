import { describe, expect, it } from "vitest";
import { CIRCULAR_MARKER, createLogger } from "../src/infrastructure/logger.js";

const fixedNow = () => new Date("2026-01-02T03:04:05.000Z");

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe("createLogger", () => {
  it("writes one JSON object per line with envelope fields", () => {
    const { lines, sink } = capture();
    createLogger("info", sink, fixedNow).info("fetched", { sourceId: "example" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      sourceId: "example",
      time: "2026-01-02T03:04:05.000Z",
      level: "info",
      message: "fetched",
    });
  });

  it("drops entries below the configured level", () => {
    const { lines, sink } = capture();
    const logger = createLogger("warn", sink, fixedNow);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      "warn",
      "error",
    ]);
  });

  it("does not let fields overwrite envelope keys", () => {
    const { lines, sink } = capture();
    createLogger("debug", sink, fixedNow).error("real", { level: "debug", message: "fake" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "error", message: "real" });
  });

  describe("field serialization never throws", () => {
    function logOnce(fields: Record<string, unknown>): Record<string, unknown> {
      const { lines, sink } = capture();
      createLogger("info", sink, fixedNow).info("m", fields);
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    }

    // toEqual (not toMatchObject) also proves no stack or other keys are written.
    it("serializes Errors as name and message, without the stack", () => {
      const entry = logOnce({
        error: new TypeError("boom"),
        nested: { cause: new Error("inner") },
      });
      expect(entry.error).toEqual({ name: "TypeError", message: "boom" });
      expect(entry.nested).toEqual({ cause: { name: "Error", message: "inner" } });
    });

    it("serializes bigint as a decimal string", () => {
      expect(logOnce({ count: 12345678901234567890n, list: [1n] })).toMatchObject({
        count: "12345678901234567890",
        list: ["1"],
      });
    });

    it("replaces circular references with a marker", () => {
      const node: Record<string, unknown> = { name: "a" };
      node.self = node;
      const list: unknown[] = [];
      list.push(list);
      expect(logOnce({ node, list })).toMatchObject({
        node: { name: "a", self: CIRCULAR_MARKER },
        list: [CIRCULAR_MARKER],
      });
    });

    it("serializes shared, non-circular references at every place", () => {
      const shared = { id: 1 };
      expect(logOnce({ a: shared, b: [shared, shared] })).toMatchObject({
        a: { id: 1 },
        b: [{ id: 1 }, { id: 1 }],
      });
    });

    it("keeps toJSON behaviour (Date as ISO string)", () => {
      expect(logOnce({ at: new Date("2026-05-06T07:08:09.000Z") })).toMatchObject({
        at: "2026-05-06T07:08:09.000Z",
      });
    });

    it("falls back to an entry without fields when a value cannot be read", () => {
      const hostile = {
        get value(): never {
          throw new Error("getter exploded");
        },
      };
      expect(logOnce({ hostile, other: 1 })).toEqual({
        time: "2026-01-02T03:04:05.000Z",
        level: "info",
        message: "m",
        logError: "fields not serializable",
      });
    });
  });
});

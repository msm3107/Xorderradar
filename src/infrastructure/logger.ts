import type { LogLevel } from "./config.js";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const severity: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Placeholder written instead of a reference back to an object already being serialized. */
export const CIRCULAR_MARKER = "[Circular]";

/**
 * Converts a field value into something JSON.stringify can always handle:
 * - Error → `{ name, message }`. The stack is left out on purpose: it adds file
 *   paths and noise to every line; callers that need it pass it explicitly.
 * - bigint → decimal string (JSON has no bigint).
 * - a reference to an ancestor (a cycle) → CIRCULAR_MARKER. Shared, non-cyclic
 *   references are serialized normally at each place they appear.
 * - objects with toJSON (e.g. Date) → their toJSON() result, as JSON.stringify does.
 * Anything else (functions, symbols, undefined) is left to JSON.stringify, which
 * drops it from objects.
 */
function toSerializable(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return CIRCULAR_MARKER;
  if (value instanceof Error) return { name: value.name, message: value.message };
  const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    return toSerializable((toJSON as () => unknown).call(value), ancestors);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toSerializable(item, ancestors));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toSerializable(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Minimal structured logger: one JSON object per line on the given sink
 * (stderr by default, so stdout stays reserved for command output).
 *
 * Serializing fields never throws: unusual values are converted (see
 * toSerializable), and if conversion still fails (a throwing getter or toJSON,
 * extreme nesting) the entry is written without fields plus
 * `"logError": "fields not serializable"`. The logger does not redact anything:
 * callers are responsible for not passing secrets or personal data in fields;
 * see docs/SECURITY.md (logging policy).
 */
export function createLogger(
  minLevel: LogLevel,
  sink: (line: string) => void = (line) => process.stderr.write(line),
  now: () => Date = () => new Date(),
): Logger {
  const log = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (severity[level] < severity[minLevel]) return;
    const envelope = { time: now().toISOString(), level, message };
    let line: string;
    try {
      const safeFields = fields === undefined ? {} : toSerializable(fields, new Set());
      // Fields first so they can never overwrite the envelope keys.
      line = JSON.stringify({ ...(safeFields as Record<string, unknown>), ...envelope });
    } catch {
      line = JSON.stringify({ ...envelope, logError: "fields not serializable" });
    }
    sink(`${line}\n`);
  };
  return {
    debug: (message, fields) => {
      log("debug", message, fields);
    },
    info: (message, fields) => {
      log("info", message, fields);
    },
    warn: (message, fields) => {
      log("warn", message, fields);
    },
    error: (message, fields) => {
      log("error", message, fields);
    },
  };
}

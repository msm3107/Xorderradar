import pg from "pg";
import { DomainError } from "../../domain/errors.js";

/**
 * Maps a PostgreSQL integrity error to a DomainError, or returns null when the
 * error is something else (connection, timeout, bug) and should propagate.
 *
 * Only the SQLSTATE and the constraint name (a schema identifier) are used.
 * The server's message and `detail` are deliberately dropped: `detail` quotes
 * the offending row/key values (e-mail addresses, source content).
 */
export function toDomainError(error: unknown): DomainError | null {
  if (!(error instanceof pg.DatabaseError) || error.code === undefined) return null;
  const constraint = error.constraint ?? null;
  const target = constraint === null ? "" : ` (${constraint})`;
  switch (error.code) {
    case "23505": // unique_violation
      return new DomainError("duplicate", `Duplicate value${target}`, [], constraint);
    case "23503": // foreign_key_violation
      return new DomainError("unknown_reference", `Unknown reference${target}`, [], constraint);
    case "23502": // not_null_violation
    case "23514": // check_violation
      return new DomainError(
        "constraint_violation",
        `Constraint violated${target}`,
        error.column === undefined ? [] : [error.column],
        constraint,
      );
    default:
      // Class 22 = data exception (bad format, out of range): an input problem.
      return error.code.startsWith("22")
        ? new DomainError("invalid_input", "Invalid input rejected by the database")
        : null;
  }
}

/** Runs a repository query, converting integrity errors into DomainError. */
export async function withDomainErrors<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (error: unknown) {
    throw toDomainError(error) ?? error;
  }
}

export type DatabaseFailureReason =
  | "unreachable"
  | "timeout"
  | "tls_failed"
  | "authentication_failed"
  | "database_not_found"
  | "no_current_schema"
  | "query_failed"
  | "unknown";

/**
 * The connection's search_path names no existing schema, so migrations have
 * nowhere to create tables (a configuration problem, not a server error).
 */
export class NoCurrentSchemaError extends Error {
  override readonly name = "NoCurrentSchemaError";

  constructor() {
    super("No current schema: search_path names no existing schema");
  }
}

export interface DatabaseFailure {
  readonly reason: DatabaseFailureReason;
  /** SQLSTATE or Node error code (e.g. `ECONNREFUSED`), when available. */
  readonly code: string | null;
}

/** Codes are short upper-case tokens; anything else is not echoed. */
const SAFE_CODE = /^[A-Z0-9_]{1,32}$/;

/** Node/libuv errno codes meaning "could not reach the server" (DNS, TCP, network). */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ETIMEDOUT",
  "EPIPE",
  "EADDRNOTAVAIL",
]);

/**
 * TLS handshake/verification failures: Node's ERR_TLS_* / ERR_SSL_* and the
 * OpenSSL verification codes (CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT,
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, ...).
 */
const TLS_CODE = /^ERR_(?:TLS|SSL)_|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/;

/**
 * Describes a database failure for operators without echoing any error
 * message: connection-level messages can embed host names or URL fragments,
 * and server messages can quote data. Only a fixed reason and a validated code
 * are returned. The password from DATABASE_URL can therefore never appear.
 */
export function describeDatabaseFailure(error: unknown): DatabaseFailure {
  const rawCode =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const code = typeof rawCode === "string" && SAFE_CODE.test(rawCode) ? rawCode : null;

  if (error instanceof pg.DatabaseError) {
    if (code === "28P01" || code === "28000") return { reason: "authentication_failed", code };
    if (code === "3D000") return { reason: "database_not_found", code };
    if (code === "57014") return { reason: "timeout", code }; // statement_timeout
    return { reason: "query_failed", code };
  }
  if (error instanceof NoCurrentSchemaError) return { reason: "no_current_schema", code };
  if (code !== null && NETWORK_CODES.has(code)) return { reason: "unreachable", code };
  if (code !== null && TLS_CODE.test(code)) return { reason: "tls_failed", code };
  // pg/pg-pool raise plain Errors without a code for their client-side timeouts.
  if (error instanceof Error && /timeout/i.test(error.message)) return { reason: "timeout", code };
  return { reason: "unknown", code };
}

/** One-line operator message, e.g. `unreachable (ECONNREFUSED)`. */
export function formatDatabaseFailure(failure: DatabaseFailure): string {
  return failure.code === null ? failure.reason : `${failure.reason} (${failure.code})`;
}

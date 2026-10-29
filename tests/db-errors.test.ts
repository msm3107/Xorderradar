import pg from "pg";
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import {
  describeDatabaseFailure,
  formatDatabaseFailure,
  NoCurrentSchemaError,
  toDomainError,
  withDomainErrors,
} from "../src/infrastructure/db/errors.js";

/** A Node-style system/TLS error with a code. */
function codedError(code: string): Error {
  return Object.assign(new Error(`failed: ${code}`), { code });
}

/** Builds the error `pg` raises for a server-side ErrorResponse. */
function serverError(code: string, fields: Partial<pg.DatabaseError> = {}): pg.DatabaseError {
  const error = new pg.DatabaseError("server message with 'secret@example.pl'", 0, "error");
  return Object.assign(error, { code, detail: "Key (email)=(secret@example.pl)", ...fields });
}

describe("toDomainError", () => {
  it.each([
    ["23505", "duplicate"],
    ["23503", "unknown_reference"],
    ["23514", "constraint_violation"],
    ["23502", "constraint_violation"],
    ["22P02", "invalid_input"],
  ] as const)("maps SQLSTATE %s to %s", (sqlstate, code) => {
    const mapped = toDomainError(serverError(sqlstate, { constraint: "some_constraint" }));
    expect(mapped).toBeInstanceOf(DomainError);
    expect(mapped?.code).toBe(code);
  });

  it("keeps the constraint name but drops the server message and detail", () => {
    const mapped = toDomainError(
      serverError("23505", { constraint: "company_profiles_email_key" }),
    );
    expect(mapped?.constraint).toBe("company_profiles_email_key");
    expect(mapped?.message).toBe("Duplicate value (company_profiles_email_key)");
    expect(JSON.stringify(mapped)).not.toContain("secret@example.pl");
    expect(mapped?.cause).toBeUndefined();
  });

  it("returns null for non-integrity errors so they propagate unchanged", () => {
    expect(toDomainError(serverError("57014"))).toBeNull();
    expect(toDomainError(new Error("connect ECONNREFUSED"))).toBeNull();
    expect(toDomainError("not an error")).toBeNull();
  });

  it("withDomainErrors rethrows other errors as they are", async () => {
    const original = new Error("boom");
    await expect(withDomainErrors(() => Promise.reject(original))).rejects.toBe(original);
    await expect(withDomainErrors(() => Promise.resolve(42))).resolves.toBe(42);
  });
});

describe("describeDatabaseFailure", () => {
  it.each([
    [serverError("28P01"), "authentication_failed", "28P01"],
    [serverError("3D000"), "database_not_found", "3D000"],
    [serverError("57014"), "timeout", "57014"],
    [serverError("42P01"), "query_failed", "42P01"],
    [
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
      "unreachable",
      "ECONNREFUSED",
    ],
    [
      Object.assign(new Error("getaddrinfo ENOTFOUND db"), { code: "ENOTFOUND" }),
      "unreachable",
      "ENOTFOUND",
    ],
    [new Error("timeout expired"), "timeout", null],
    [new Error("Query read timeout"), "timeout", null],
    [new Error("something else"), "unknown", null],
    ["a string", "unknown", null],
  ])("classifies %o", (error, reason, code) => {
    expect(describeDatabaseFailure(error)).toEqual({ reason, code });
  });

  it.each([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
  ])("treats the network code %s as unreachable", (code) => {
    expect(describeDatabaseFailure(codedError(code))).toEqual({ reason: "unreachable", code });
  });

  it.each([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ])("treats the TLS code %s as tls_failed", (code) => {
    expect(describeDatabaseFailure(codedError(code))).toEqual({ reason: "tls_failed", code });
  });

  it.each(["EACCES", "EMFILE", "ERR_INVALID_ARG_TYPE"])(
    "does not guess for other codes (%s): unknown, with the code",
    (code) => {
      expect(describeDatabaseFailure(codedError(code))).toEqual({ reason: "unknown", code });
    },
  );

  it("reports a missing schema with its own fixed reason", () => {
    expect(describeDatabaseFailure(new NoCurrentSchemaError())).toEqual({
      reason: "no_current_schema",
      code: null,
    });
  });

  it("never echoes an unusual code value", () => {
    const error = Object.assign(new Error("x"), { code: "postgres://u:pw@host/db" });
    expect(describeDatabaseFailure(error)).toEqual({ reason: "unknown", code: null });
  });

  it("formats a one-line operator message", () => {
    expect(formatDatabaseFailure({ reason: "unreachable", code: "ECONNREFUSED" })).toBe(
      "unreachable (ECONNREFUSED)",
    );
    expect(formatDatabaseFailure({ reason: "timeout", code: null })).toBe("timeout");
  });
});

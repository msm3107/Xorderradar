/**
 * Why a write or lookup was refused, independent of the storage technology:
 * - `invalid_input`: the value does not satisfy the domain schema (or the
 *   database rejected its format);
 * - `duplicate`: a uniqueness rule was violated (e.g. the same e-mail twice);
 * - `unknown_reference`: the value points to something that does not exist
 *   (e.g. an opportunity for an unregistered source);
 * - `constraint_violation`: any other integrity rule (CHECK, NOT NULL).
 */
export type DomainErrorCode =
  "invalid_input" | "duplicate" | "unknown_reference" | "constraint_violation";

/**
 * Explicit, safe-to-show error for refused writes and lookups. The message and
 * fields name *what* was wrong (field paths, constraint names) but never the
 * offending values, which may be personal data or arbitrary source content.
 */
export class DomainError extends Error {
  override readonly name = "DomainError";

  constructor(
    readonly code: DomainErrorCode,
    message: string,
    /** Field paths (`invalid_input`) — names only, never values. */
    readonly fields: readonly string[] = [],
    /** Database constraint name, when the refusal came from one. */
    readonly constraint: string | null = null,
  ) {
    super(message);
  }
}

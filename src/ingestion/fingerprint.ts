import { createHash } from "node:crypto";
import type { OpportunityCandidate } from "../domain/opportunity.js";

/*
 * Deduplication key and change detection (docs/ARCHITECTURE.md §5, D-016).
 * Both are SHA-256 hex digests (64 characters) of a canonical JSON text, so
 * the encoding is unambiguous: no separator a value could contain, and `null`
 * is distinct from `""` and from an absent field. Both are computed from a
 * candidate validated by `opportunityCandidateSchema`, i.e. from canonical
 * values (trimmed text, canonical URL), never from raw source text.
 *
 * Changing either encoding changes every stored value: existing rows would be
 * seen as new (fingerprint) or as updated once (content hash). Do it only with
 * a migration plan.
 */

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deduplication key of a notice within its source: the source's own
 * identifier when it has one, otherwise the notice URL. The variant for
 * sources whose URLs are not stable (source, issuer, title, publication date)
 * is deferred until such a source exists (D-016).
 */
export function fingerprint(
  candidate: Pick<OpportunityCandidate, "sourceId" | "externalId" | "sourceUrl">,
): string {
  const key =
    candidate.externalId === null
      ? [candidate.sourceId, "url", candidate.sourceUrl]
      : [candidate.sourceId, "external", candidate.externalId];
  return sha256Hex(JSON.stringify(key));
}

/**
 * The JSON value of a field: dates as ISO strings, plain objects with sorted
 * keys (so key order never matters) and keys whose value is `undefined`
 * dropped (absent), arrays in their order (category order is as published).
 */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/**
 * Fields that describe the notice, in a fixed order. Not included:
 * `sourceId` (part of the fingerprint already) and `fetchedAt` (when we looked,
 * not what was published — including it would make every run an update).
 */
const CONTENT_FIELDS = [
  "issuerName",
  "title",
  "description",
  "location",
  "publishedAt",
  "deadline",
  "estimatedValue",
  "currency",
  "categories",
  "contact",
  "status",
  "sourceUrl",
  "externalId",
  "tenderId",
] as const satisfies readonly (keyof OpportunityCandidate)[];

/**
 * Hash of the notice content, compared on every ingest to tell `updated` from
 * `unchanged`. Encoded as `[name, value]` pairs in CONTENT_FIELDS order; an
 * absent field (`undefined`) has no pair, so it differs from `null`.
 */
export function contentHash(candidate: OpportunityCandidate): string {
  // Read through a plain record: the type says every field is present, but the
  // encoding must stay unambiguous even for a value that breaks the type.
  const fields: Readonly<Record<string, unknown>> = candidate;
  const pairs = CONTENT_FIELDS.filter((name) => fields[name] !== undefined).map((name) => [
    name,
    canonical(fields[name]),
  ]);
  return sha256Hex(JSON.stringify(pairs));
}

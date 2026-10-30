import { z } from "zod";
import { emailSchema, httpUrlSchema, labelList, text } from "./common.js";
import { sourceIdSchema } from "./source.js";

export const opportunityStatuses = ["open", "closed", "cancelled", "unknown"] as const;
export type OpportunityStatus = (typeof opportunityStatuses)[number];

/** True when an object has at least one key; an empty object would carry no information. */
const notEmpty = (value: object) => Object.keys(value).length > 0;

/**
 * Location as published with the notice. Only what the source states; a
 * missing part is simply absent and a notice without any location is `null`,
 * never an empty object.
 */
export const locationSchema = z
  .strictObject({
    voivodeship: text(100).optional(),
    county: text(100).optional(),
    city: text(200).optional(),
    /** The location text exactly as published, when it could not be split. */
    raw: text(500).optional(),
  })
  .refine(notEmpty, "location must have at least one field (use null when unknown)");

export type OpportunityLocation = z.output<typeof locationSchema>;

/**
 * Contact published *with this notice* (docs/MASTER_PROMPT.md §9) — never
 * enriched from elsewhere. Same rules as location: absent parts are omitted.
 */
export const contactSchema = z
  .strictObject({
    name: text(200).optional(),
    email: emailSchema.optional(),
    phone: text(50).optional(),
    raw: text(500).optional(),
  })
  .refine(notEmpty, "contact must have at least one field (use null when unknown)");

export type OpportunityContact = z.output<typeof contactSchema>;

/**
 * Non-negative decimal kept as a string: PostgreSQL `numeric` is returned as a
 * string by `pg`, and money must not go through floating point. Up to 15
 * integer and 4 fractional digits; no sign, exponent or leading zeros.
 */
export const decimalAmountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/, "non-negative decimal, e.g. 12500.00");

/** ISO 4217 code, e.g. `PLN`. */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, "3-letter upper-case ISO code");

/**
 * Fields of a normalized notice as produced by a source adapter. Every optional
 * field is `null` when the source does not provide it — never 0, an empty
 * string or a guess. A plain shape (not a schema) so the candidate and the
 * draft share one set of field rules: zod cannot `.omit()` from a refined object.
 */
const opportunityCandidateShape = {
  sourceId: sourceIdSchema,
  sourceUrl: httpUrlSchema,
  externalId: text(200).nullable(),
  issuerName: text(500),
  title: text(1000),
  description: text(10_000).nullable(),
  location: locationSchema.nullable(),
  publishedAt: z.date().nullable(),
  deadline: z.date().nullable(),
  estimatedValue: decimalAmountSchema.nullable(),
  currency: currencySchema.nullable(),
  categories: labelList(),
  contact: contactSchema.nullable(),
  fetchedAt: z.date(),
  status: z.enum(opportunityStatuses),
};

/** `currency` is required exactly when `estimatedValue` is present. */
function valueHasCurrency(value: { estimatedValue: string | null; currency: string | null }) {
  return (value.estimatedValue === null) === (value.currency === null);
}
const currencyIssue = {
  message: "currency is required exactly when estimatedValue is present",
  path: ["currency"],
};

/**
 * What a source adapter's `normalize` returns (src/sources): an
 * OpportunityDraft without `fingerprint` and `contentHash`, whose rules belong
 * to ingestion (PR-03).
 */
export const opportunityCandidateSchema = z
  .strictObject(opportunityCandidateShape)
  .refine(valueHasCurrency, currencyIssue);

export type OpportunityCandidate = z.output<typeof opportunityCandidateSchema>;

/**
 * A normalized notice ready to be stored: the candidate plus its deduplication
 * key and content hash.
 *
 * `fingerprint` (deduplication key) and `contentHash` are taken as given: the
 * rules that compute them belong to ingestion (PR-03).
 */
export const opportunityDraftSchema = z
  .strictObject({
    ...opportunityCandidateShape,
    fingerprint: text(200),
    contentHash: text(200),
  })
  .refine(valueHasCurrency, currencyIssue);

export type OpportunityDraft = z.input<typeof opportunityDraftSchema>;

export interface Opportunity extends z.output<typeof opportunityDraftSchema> {
  readonly id: string;
  /** When the deduplication key was stored for the first time; never changes. */
  readonly firstSeenAt: Date;
  /** Last time the stored row was written (insert or update). */
  readonly updatedAt: Date;
}

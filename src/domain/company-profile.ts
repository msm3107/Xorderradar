import { z } from "zod";
import { emailSchema, labelList, text } from "./common.js";

/**
 * Company profile = subscription (docs/DECISIONS.md D-009): the alert recipient
 * and the matching preferences in one record. Lists may be empty; region lists
 * hold names as entered (normalization to a dictionary is PR-03/PR-04).
 */
const profileFields = {
  email: emailSchema,
  name: text(200),
  categories: labelList(),
  includeKeywords: labelList(),
  excludeKeywords: labelList(),
  voivodeships: labelList(),
  counties: labelList(),
  active: z.boolean(),
};

/** Every field is explicit on create: no hidden defaults for preferences. */
export const companyProfileInputSchema = z.strictObject(profileFields);

/**
 * Partial update; at least one field must be given. A key whose value is
 * `undefined` does not count: it would not change anything.
 */
export const companyProfilePatchSchema = z
  .strictObject(profileFields)
  .partial()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "at least one field is required",
  );

export type CompanyProfileInput = z.input<typeof companyProfileInputSchema>;
export type CompanyProfilePatch = z.input<typeof companyProfilePatchSchema>;

export interface CompanyProfile extends z.output<typeof companyProfileInputSchema> {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

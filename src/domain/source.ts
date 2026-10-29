import { z } from "zod";
import { httpUrlSchema, text } from "./common.js";

/** Stable, human-readable source identifier, e.g. `baza-konkurencyjnosci`. */
export const sourceIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lower-case letters, digits and single hyphens");

/** A public source as registered by the operator / adapter. */
export const sourceInputSchema = z.strictObject({
  id: sourceIdSchema,
  name: text(200),
  baseUrl: httpUrlSchema,
  enabled: z.boolean(),
});

export type SourceInput = z.input<typeof sourceInputSchema>;

export interface Source extends z.output<typeof sourceInputSchema> {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

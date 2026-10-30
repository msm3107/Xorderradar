import { z } from "zod";
import { text } from "./common.js";
import { sourceIdSchema } from "./source.js";

/**
 * Why a notice update carries nothing to apply (fixed codes, safe to log):
 * it changes another kind of notice than a contract notice, or it changes
 * something other than the offer deadline (D-015).
 */
export const noticeUpdateNoneReasons = [
  "not_contract_notice_change",
  "no_deadline_change",
] as const;
export type NoticeUpdateNoneReason = (typeof noticeUpdateNoneReasons)[number];

export const noticeUpdateChangeSchema = z.discriminatedUnion("kind", [
  /** The new offer deadline, as an instant (the source's local time converted to UTC). */
  z.strictObject({ kind: z.literal("deadline"), deadline: z.date() }),
  z.strictObject({ kind: z.literal("none"), reason: z.enum(noticeUpdateNoneReasons) }),
]);

export type NoticeUpdateChange = z.output<typeof noticeUpdateChangeSchema>;

/**
 * A published change to an earlier notice (BZP: "Ogłoszenie o zmianie
 * ogłoszenia", D-015), as produced by a source adapter's `normalize`. Never
 * stored as an opportunity of its own: ingestion applies `change` to the
 * original notice, found by `tenderId` (null when the source gives none).
 */
export const noticeUpdateSchema = z.strictObject({
  sourceId: sourceIdSchema,
  /** The update notice's own number, e.g. `2026/BZP 00507126/01`. */
  externalId: text(200),
  tenderId: text(200).nullable(),
  publishedAt: z.date(),
  fetchedAt: z.date(),
  change: noticeUpdateChangeSchema,
});

export type NoticeUpdate = z.output<typeof noticeUpdateSchema>;

/**
 * A new offer deadline ready to be applied to the original notice of
 * `tenderId` (applyDeadlineUpdate): the update notice's number and publication
 * time are stored with it as its provenance. `status` follows from the
 * deadline and the time the update was fetched, as for a fetched notice.
 */
export const deadlineUpdateSchema = z.strictObject({
  sourceId: sourceIdSchema,
  tenderId: text(200),
  updateNotice: text(200),
  updatePublishedAt: z.date(),
  deadline: z.date(),
  status: z.enum(["open", "closed"]),
});

export type DeadlineUpdate = z.input<typeof deadlineUpdateSchema>;

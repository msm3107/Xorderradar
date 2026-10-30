import type { NoticeUpdate } from "../domain/notice-update.js";
import type { OpportunityCandidate } from "../domain/opportunity.js";
import type { FetchContext, IncompleteFetch, SourceAdapter } from "./types.js";

export interface SourceRejection {
  readonly externalId: string | null;
  readonly reason: string;
}

export interface SourcePreview {
  readonly documents: number;
  readonly extracted: number;
  readonly candidates: readonly OpportunityCandidate[];
  /** Changes to earlier notices; listed only, never applied (nothing is stored). */
  readonly updates: readonly NoticeUpdate[];
  readonly rejections: readonly SourceRejection[];
  readonly incomplete: readonly IncompleteFetch[];
}

/**
 * One source run without storage: fetch → extract → normalize. Rejected
 * records are counted and logged (sourceId, notice id, fixed reason), never
 * dropped silently. Fetch and document errors propagate to the caller.
 */
export async function previewSource(
  adapter: SourceAdapter,
  ctx: FetchContext,
): Promise<SourcePreview> {
  const { documents, incomplete } = await adapter.fetch(ctx);
  const candidates: OpportunityCandidate[] = [];
  const updates: NoticeUpdate[] = [];
  const rejections: SourceRejection[] = [];
  let extracted = 0;
  for (const document of documents) {
    for (const notice of adapter.extract(document)) {
      extracted++;
      const result = adapter.normalize(notice);
      if (result.ok) {
        if (result.kind === "opportunity") candidates.push(result.candidate);
        else updates.push(result.update);
      } else {
        rejections.push({ externalId: result.externalId, reason: result.reason });
        ctx.logger.warn("source record rejected", {
          sourceId: adapter.sourceId,
          externalId: result.externalId,
          reason: result.reason,
        });
      }
    }
  }
  return { documents: documents.length, extracted, candidates, updates, rejections, incomplete };
}

import { z } from "zod";
import { opportunityCandidateSchema } from "../../src/domain/opportunity.js";
import type { FetchContext, RawDocument, SourceAdapter } from "../../src/sources/types.js";

/**
 * A scripted source for ingestion tests, without the network: each step of
 * the script is one document (a list of notices) or an error thrown at that
 * point of the fetch. Records are synthetic and pseudonymised.
 */
const fakeNoticeSchema = z.object({
  externalId: z.string().nullable(),
  tenderId: z.string().nullable(),
  title: z.string(),
  deadline: z.string().nullable(),
  /** Makes normalize reject the record (reason names no values). */
  invalid: z.boolean(),
});
export type FakeNotice = z.output<typeof fakeNoticeSchema>;
type FakeExtracted = FakeNotice & { readonly fetchedAt: Date };

export type FakeStep = readonly FakeNotice[] | Error | ((ctx: FetchContext) => Promise<void>);

export interface FakeSource extends SourceAdapter<FakeExtracted> {
  /** Replaces the script for the next fetch. */
  script: readonly FakeStep[];
  /** Number of `fetch` calls so far. */
  fetches: number;
}

export function fakeNotice(n: number, overrides: Partial<FakeNotice> = {}): FakeNotice {
  return {
    externalId: `FAKE/${String(n).padStart(4, "0")}`,
    tenderId: null,
    title: `Dostawa materiałów biurowych nr ${String(n)}`,
    deadline: "2026-11-20T09:00:00.000Z",
    invalid: false,
    ...overrides,
  };
}

export function fakeSource(sourceId: string, script: readonly FakeStep[] = []): FakeSource {
  const source: FakeSource = {
    sourceId,
    allowedHosts: ["zamowienia.example.invalid"],
    script,
    fetches: 0,
    async fetch(ctx) {
      source.fetches++;
      const documents: RawDocument[] = [];
      for (const step of source.script) {
        if (step instanceof Error) throw step;
        if (typeof step === "function") {
          await step(ctx);
          continue;
        }
        const doc: RawDocument = {
          sourceId,
          url: `https://zamowienia.example.invalid/lista?strona=${String(documents.length + 1)}`,
          fetchedAt: ctx.now(),
          contentType: "application/json",
          body: JSON.stringify(step),
        };
        if (ctx.onDocument === undefined) documents.push(doc);
        else await ctx.onDocument(doc);
      }
      return { documents, incomplete: [] };
    },
    extract(doc) {
      const parsed: unknown = JSON.parse(doc.body);
      return z
        .array(fakeNoticeSchema)
        .parse(parsed)
        .map((notice) => ({ ...notice, fetchedAt: doc.fetchedAt }));
    },
    normalize(notice) {
      if (notice.invalid) {
        return { ok: false, externalId: notice.externalId, reason: "invalid value: title" };
      }
      const { fetchedAt } = notice;
      const deadline = notice.deadline === null ? null : new Date(notice.deadline);
      const result = opportunityCandidateSchema.safeParse({
        sourceId,
        sourceUrl: `https://zamowienia.example.invalid/ogloszenie/${encodeURIComponent(
          notice.externalId ?? notice.title,
        )}`,
        externalId: notice.externalId,
        tenderId: notice.tenderId,
        issuerName: "Gmina Przykładowa",
        title: notice.title,
        description: null,
        location: { city: "Przykładowo" },
        publishedAt: new Date("2026-10-29T08:00:00.000Z"),
        deadline,
        estimatedValue: null,
        currency: null,
        categories: ["30192000-1"],
        contact: { name: "Jan Kowalski", email: "kontakt@example.invalid", phone: "000 000 000" },
        fetchedAt,
        status: deadline === null ? "unknown" : "open",
      });
      if (!result.success) return { ok: false, externalId: notice.externalId, reason: "invalid" };
      return { ok: true, kind: "opportunity", candidate: result.data };
    },
  };
  return source;
}

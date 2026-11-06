import { warsawDay } from "../normalize/warsaw-time.js";

/**
 * The Baza Konkurencyjności's id and the attribution its terms of reuse
 * require (D-030), kept apart from the adapter so the digest and the web pages
 * do not load the adapter's schemas.
 */
export const BK_SOURCE_ID = "bk";

/** The label of the attribution field, in the digest and on a match card. */
export const ATTRIBUTION_LABEL = "Źródło";

/** Full names, as the source's terms of reuse require (D-030). */
const BK_ATTRIBUTION = "Baza Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej";

/**
 * The attribution of one Baza Konkurencyjności offer: the source with the
 * ministry's full name, the date the data were obtained — `fetchedAt`, when
 * the content shown was last fetched (an unchanged re-read keeps it) — as a
 * day in Poland, and that the data were processed.
 */
export function bkAttribution(fetchedAt: Date): string {
  return `${BK_ATTRIBUTION}; pobrano ${warsawDay(fetchedAt)}; dane przetworzone: skrócone i ujednolicone`;
}

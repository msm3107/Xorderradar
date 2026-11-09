import type { CompanyProfile } from "../domain/company-profile.js";
import type { Opportunity } from "../domain/opportunity.js";
import { CATEGORY_LABELS } from "../domain/vocabulary.js";
import { matchOpportunity } from "../matching/match.js";
import { offerCard } from "../notifications/card.js";
import { digestOrder } from "../notifications/digest.js";
import { BK_SOURCE_ID } from "../sources/bk/attribution.js";
import { warsawLocalToUtc, warsawWallTime } from "../sources/normalize/warsaw-time.js";
import type { ExampleView } from "./pages.js";

/**
 * The sample digest of GET /przyklad (PR-10, PR-11): made-up data — a
 * pseudonymised profile and offers with `.invalid` links — matched and shown
 * by the same code as /dopasowania, so the sample cannot drift from the real
 * view. No database. Dates are relative to the render time, so the deadline
 * lines always show what a real card shows; one page has the main states
 * of a card: a value and none, a normal, an urgent („jutro”) and no deadline,
 * a long description (cut, with the full one folded), a short one and none, a
 * region the source does not give and a CPV code outside the vocabulary, BZP
 * and the Baza Konkurencyjności. Not „dziś” (its hour may be past already) nor
 * „minął” (a passed offer is never listed).
 */

/** Exported for the test that every sample offer really matches it. */
export const EXAMPLE_PROFILE: CompanyProfile = {
  id: "00000000-0000-4000-8000-00000000e001",
  email: "jan.kowalski@example.invalid",
  name: "Jan Kowalski Elektryka",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie", "instalacja elektryczna"],
  excludeKeywords: ["dostawa energii"],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
  createdAt: new Date("2026-01-05T08:00:00.000Z"),
  updatedAt: new Date("2026-01-05T08:00:00.000Z"),
};

const DAY_MS = 86_400_000;

/**
 * `days` Polish calendar days from `now`'s day, at `hour`:00 Warsaw time. The
 * hours used are never inside a DST change, so the conversion always has one
 * answer; the fallback only satisfies the type.
 */
function warsawDayAt(now: Date, days: number, hour: number): Date {
  const today = warsawWallTime(now);
  const day = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
  return (
    warsawLocalToUtc({
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour,
      minute: 0,
    }) ?? new Date(now.getTime() + days * DAY_MS)
  );
}

/** More than SNIPPET_MAX_CHARS: the card shows an excerpt and folds the rest. */
const LONG_DESCRIPTION =
  "Przedmiotem zamówienia jest wymiana 120 opraw oświetlenia ulicznego na oprawy LED wraz " +
  "z przebudową instalacji elektrycznej zasilającej na ulicach Lipowej, Klonowej i Polnej. " +
  "Zakres obejmuje demontaż istniejących opraw i wysięgników, montaż nowych opraw z układem " +
  "redukcji mocy w godzinach nocnych, wymianę przewodów w słupach, pomiary natężenia " +
  "oświetlenia po wykonaniu robót oraz przekazanie zdemontowanych opraw do utylizacji. " +
  "Wykonawca udzieli co najmniej 60 miesięcy gwarancji na oprawy i wykonane roboty.";

/** The sample offers at `now` (exported for the test that each one matches). */
export function exampleOffers(now: Date): Opportunity[] {
  const fetchedAt = warsawDayAt(now, -1, 7);
  const base = {
    tenderId: null,
    contentHash: "przyklad",
    status: "open",
    fetchedAt,
    firstSeenAt: fetchedAt,
    updatedAt: fetchedAt,
  } as const;
  return [
    {
      ...base,
      id: "00000000-0000-4000-8000-00000000e101",
      sourceId: "bzp",
      sourceUrl: "https://bzp.przyklad.invalid/ogloszenie/1",
      externalId: "przyklad-bzp-1",
      fingerprint: "przyklad-bzp-1",
      issuerName: "Gmina Przykładowo",
      title: "Modernizacja oświetlenia ulicznego w Przykładowie",
      description: LONG_DESCRIPTION,
      location: { city: "Przykładowo", voivodeship: "mazowieckie" },
      publishedAt: warsawDayAt(now, -1, 10),
      deadline: warsawDayAt(now, 12, 10),
      estimatedValue: "120000.00",
      currency: "PLN",
      categories: ["45316110-9", "45310000-3"],
      contact: { email: "zamowienia@gmina.przyklad.invalid" },
    },
    {
      ...base,
      id: "00000000-0000-4000-8000-00000000e102",
      sourceId: BK_SOURCE_ID,
      sourceUrl: "https://bk.przyklad.invalid/ogloszenie/2",
      externalId: "przyklad-bk-2",
      fingerprint: "przyklad-bk-2",
      issuerName: "Przykładowa Fundacja Rozwoju",
      title: "Wykonanie instalacji elektrycznej w budynku szkoleniowym",
      description: "Instalacja elektryczna i oświetlenie sal w ramach projektu z funduszy UE.",
      location: { city: "Wzorowo", voivodeship: "mazowieckie" },
      publishedAt: warsawDayAt(now, -2, 13),
      deadline: warsawDayAt(now, 1, 12),
      estimatedValue: null,
      currency: null,
      categories: ["45311000-0"],
      contact: { name: "Anna Nowak", phone: "000 000 000" },
    },
    {
      // No MVP category behind its CPV code: the keywords and the region carry it.
      ...base,
      id: "00000000-0000-4000-8000-00000000e103",
      sourceId: "bzp",
      sourceUrl: "https://bzp.przyklad.invalid/ogloszenie/3",
      externalId: "przyklad-bzp-3",
      fingerprint: "przyklad-bzp-3",
      issuerName: "Szkoła Podstawowa w Przykładowie",
      title: "Projekt oświetlenia boiska szkolnego",
      description: "Projekt wraz z kosztorysem; instalacja elektryczna zasilania masztów.",
      location: { city: "Przykładowo", voivodeship: "mazowieckie" },
      publishedAt: warsawDayAt(now, -1, 9),
      deadline: null,
      estimatedValue: "48500.00",
      currency: "PLN",
      categories: ["71320000-7"],
      contact: null,
    },
    {
      // The source names the city only: the region is unknown, category and keyword carry it.
      ...base,
      id: "00000000-0000-4000-8000-00000000e104",
      sourceId: "bzp",
      sourceUrl: "https://bzp.przyklad.invalid/ogloszenie/4",
      externalId: "przyklad-bzp-4",
      fingerprint: "przyklad-bzp-4",
      issuerName: "Zarząd Dróg Powiatowych w Wzorowie",
      title: "Konserwacja oświetlenia drogowego",
      description: null,
      location: { city: "Wzorowo" },
      publishedAt: warsawDayAt(now, -3, 11),
      deadline: warsawDayAt(now, 6, 9),
      estimatedValue: null,
      currency: null,
      categories: ["45316110-9"],
      contact: null,
    },
  ];
}

/** The sample profile and its cards at `now`, in the order of /dopasowania (soonest deadline first). */
export function exampleView(now: Date): ExampleView {
  return {
    name: EXAMPLE_PROFILE.name,
    summary:
      [
        `kategoria: ${EXAMPLE_PROFILE.categories.map((category) => CATEGORY_LABELS[category]).join(", ")}`,
        `województwo: ${EXAMPLE_PROFILE.voivodeships.join(", ")}`,
        `słowa kluczowe: ${EXAMPLE_PROFILE.includeKeywords.join(", ")}`,
      ].join("; ") + ".",
    items: exampleOffers(now)
      .map((offer) => ({ offer, reasons: matchOpportunity(offer, EXAMPLE_PROFILE).reasons }))
      .sort(digestOrder)
      .map((item) => offerCard(item, now)),
  };
}

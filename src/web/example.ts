import type { CompanyProfile } from "../domain/company-profile.js";
import type { Opportunity } from "../domain/opportunity.js";
import { CATEGORY_LABELS } from "../domain/vocabulary.js";
import { matchOpportunity } from "../matching/match.js";
import { digestItemView, digestOrder, type DigestItemView } from "../notifications/digest.js";
import { BK_SOURCE_ID } from "../sources/bk/attribution.js";

/**
 * The sample digest of GET /przyklad (PR-10): constant, made-up data — a
 * pseudonymised profile and offers with `.invalid` links — matched and shown
 * by the same code as /dopasowania, so the sample cannot drift from the real
 * view. No database, no clock: the page is the same for every visitor.
 */

const EXAMPLE_PROFILE: CompanyProfile = {
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

const FETCHED_AT = new Date("2026-03-02T05:00:00.000Z");

/** Fields every sample offer shares. */
const BASE = {
  tenderId: null,
  estimatedValue: null,
  currency: null,
  contentHash: "przyklad",
  status: "open",
  fetchedAt: FETCHED_AT,
  firstSeenAt: FETCHED_AT,
  updatedAt: FETCHED_AT,
} as const;

const EXAMPLE_OFFERS: readonly Opportunity[] = [
  {
    ...BASE,
    id: "00000000-0000-4000-8000-00000000e101",
    sourceId: "bzp",
    sourceUrl: "https://bzp.przyklad.invalid/ogloszenie/1",
    externalId: "przyklad-bzp-1",
    fingerprint: "przyklad-bzp-1",
    issuerName: "Gmina Przykładowo",
    title: "Modernizacja oświetlenia ulicznego w Przykładowie",
    description:
      "Wymiana 120 opraw oświetlenia ulicznego na oprawy LED wraz z przebudową " +
      "instalacji elektrycznej zasilającej.",
    location: { city: "Przykładowo", voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-03-01T09:00:00.000Z"),
    deadline: new Date("2026-03-16T10:00:00.000Z"),
    categories: ["45316110-9", "45310000-3"],
    contact: { email: "zamowienia@gmina.przyklad.invalid" },
  },
  {
    ...BASE,
    id: "00000000-0000-4000-8000-00000000e102",
    sourceId: BK_SOURCE_ID,
    sourceUrl: "https://bk.przyklad.invalid/ogloszenie/2",
    externalId: "przyklad-bk-2",
    fingerprint: "przyklad-bk-2",
    issuerName: "Przykładowa Fundacja Rozwoju",
    title: "Wykonanie instalacji elektrycznej w budynku szkoleniowym",
    description: "Instalacja elektryczna i oświetlenie sal w ramach projektu z funduszy UE.",
    location: { city: "Wzorowo", voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-02-27T12:00:00.000Z"),
    deadline: new Date("2026-03-10T11:00:00.000Z"),
    categories: ["45311000-0"],
    contact: null,
  },
];

/** The sample cards, in the order of /dopasowania (soonest deadline first). */
export const EXAMPLE_ITEMS: readonly DigestItemView[] = EXAMPLE_OFFERS.map((offer) => ({
  offer,
  reasons: matchOpportunity(offer, EXAMPLE_PROFILE).reasons,
}))
  .sort(digestOrder)
  .map(digestItemView);

/** The sample profile as /przyklad describes it above the cards. */
export const EXAMPLE_PROFILE_VIEW = {
  name: EXAMPLE_PROFILE.name,
  summary:
    [
      `kategoria: ${EXAMPLE_PROFILE.categories.map((category) => CATEGORY_LABELS[category]).join(", ")}`,
      `województwo: ${EXAMPLE_PROFILE.voivodeships.join(", ")}`,
      `słowa kluczowe: ${EXAMPLE_PROFILE.includeKeywords.join(", ")}`,
    ].join("; ") + ".",
} as const;

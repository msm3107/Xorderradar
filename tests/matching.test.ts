import { describe, expect, it } from "vitest";
import { formatReason, formatReasons } from "../src/matching/format.js";
import {
  countyKey,
  MATCH_THRESHOLD,
  matchOpportunity,
  POINTS,
  type MatchableOpportunity,
  type MatchableProfile,
  type MatchReason,
} from "../src/matching/match.js";
import { keywordTokenCount } from "../src/domain/company-profile.js";
import { containsKeyword, findKeyword, prepareKeywords, tokenize } from "../src/matching/text.js";

// Table-driven matching tests (PR-04). Offers and profiles carry only the
// fields matching reads; everything not given is empty / unknown.

function offer(overrides: Partial<MatchableOpportunity> = {}): MatchableOpportunity {
  return { title: "Zamówienie", description: null, categories: [], location: null, ...overrides };
}

function profile(overrides: Partial<MatchableProfile> = {}): MatchableProfile {
  return {
    categories: ["elektryka"],
    includeKeywords: [],
    excludeKeywords: [],
    voivodeships: [],
    counties: [],
    ...overrides,
  };
}

const ELEKTRYKA_CPV = "45310000-3";
const MAZOWIECKIE = { voivodeship: "mazowieckie" };

function kinds(reasons: readonly MatchReason[]): string[] {
  return reasons.map((reason) => reason.kind);
}

describe("matchOpportunity — scoring table", () => {
  it.each<{
    name: string;
    offer: MatchableOpportunity;
    profile: MatchableProfile;
    score: number;
    matched: boolean;
    kinds: string[];
  }>([
    {
      name: "category + region without restriction",
      offer: offer({ categories: [ELEKTRYKA_CPV] }),
      profile: profile(),
      score: 60,
      matched: true,
      kinds: ["category", "region_unrestricted"],
    },
    {
      name: "category + matching voivodeship",
      offer: offer({ categories: [ELEKTRYKA_CPV], location: MAZOWIECKIE }),
      profile: profile({ voivodeships: ["mazowieckie"] }),
      score: 60,
      matched: true,
      kinds: ["category", "region_match"],
    },
    {
      name: "category alone with no offer location (AC3: not a region match)",
      offer: offer({ categories: [ELEKTRYKA_CPV] }),
      profile: profile({ voivodeships: ["mazowieckie"] }),
      score: 40,
      matched: false,
      kinds: ["category", "region_unknown"],
    },
    {
      name: "category + keyword with no offer location",
      offer: offer({ title: "Oświetlenie ulic", categories: [ELEKTRYKA_CPV] }),
      profile: profile({ includeKeywords: ["oświetlenie"], voivodeships: ["mazowieckie"] }),
      score: 70,
      matched: true,
      kinds: ["category", "keyword", "region_unknown"],
    },
    {
      name: "keyword + matching region, offer without CPV (AC6)",
      offer: offer({ title: "Wymiana oświetlenia w szkole", location: MAZOWIECKIE }),
      profile: profile({ includeKeywords: ["oświetlenie"], voivodeships: ["mazowieckie"] }),
      score: 50,
      matched: true,
      kinds: ["category_unverifiable", "keyword", "region_match"],
    },
    {
      name: "keyword alone with unknown region",
      offer: offer({ title: "Wymiana oświetlenia w szkole" }),
      profile: profile({ includeKeywords: ["oświetlenie"], voivodeships: ["mazowieckie"] }),
      score: 30,
      matched: false,
      kinds: ["category_unverifiable", "keyword", "region_unknown"],
    },
    {
      name: "category + two keywords + region",
      offer: offer({
        title: "Modernizacja oświetlenia i monitoringu",
        categories: [ELEKTRYKA_CPV],
        location: MAZOWIECKIE,
      }),
      profile: profile({
        includeKeywords: ["oświetlenie", "monitoring", "klimatyzacja"],
        voivodeships: ["mazowieckie"],
      }),
      score: 100,
      matched: true,
      kinds: ["category", "keyword", "keyword", "more_keywords", "region_match"],
    },
    {
      name: "an excluding keyword always excludes (AC2)",
      offer: offer({
        title: "Oświetlenie i dostawa paliwa",
        categories: [ELEKTRYKA_CPV],
        location: MAZOWIECKIE,
      }),
      profile: profile({
        includeKeywords: ["oświetlenie"],
        excludeKeywords: ["paliwo"],
        voivodeships: ["mazowieckie"],
      }),
      score: -10,
      matched: false,
      kinds: ["category", "keyword", "exclude", "region_match"],
    },
    {
      name: "an excluding keyword in the description excludes too",
      offer: offer({
        title: "Oświetlenie",
        description: "W tym dostawa paliwa do agregatu.",
        categories: [ELEKTRYKA_CPV],
      }),
      profile: profile({
        includeKeywords: ["oświetlenie", "agregat"],
        excludeKeywords: ["dostawa paliwa"],
      }),
      score: 40 + 30 + 0 + 10 - 100 + 20,
      matched: false,
      kinds: ["category", "keyword", "keyword", "more_keywords", "exclude", "region_unrestricted"],
    },
    {
      name: "a region mismatch is never a match, whatever the score",
      offer: offer({
        title: "Oświetlenie i monitoring",
        categories: [ELEKTRYKA_CPV],
        location: { voivodeship: "śląskie" },
      }),
      profile: profile({
        includeKeywords: ["oświetlenie", "monitoring"],
        voivodeships: ["mazowieckie"],
      }),
      score: 80,
      matched: false,
      kinds: ["category", "keyword", "keyword", "more_keywords", "region_mismatch"],
    },
    {
      name: "another category only",
      offer: offer({ categories: ["45453000-7"], location: MAZOWIECKIE }),
      profile: profile({ voivodeships: ["mazowieckie"] }),
      score: 20,
      matched: false,
      kinds: ["category_mismatch", "region_match"],
    },
    {
      name: "CPV outside the dictionary: the category cannot be checked",
      offer: offer({ categories: ["45000000-7"] }),
      profile: profile(),
      score: 20,
      matched: false,
      kinds: ["category_unverifiable", "region_unrestricted"],
    },
  ])("$name", ({ offer: o, profile: p, score, matched, kinds: expected }) => {
    const result = matchOpportunity(o, p);
    expect(kinds(result.reasons)).toEqual(expected);
    expect(result.score).toBe(score);
    expect(result.matched).toBe(matched);
  });

  it("documents the rules in POINTS and MATCH_THRESHOLD", () => {
    expect(POINTS).toEqual({
      category: 40,
      keyword: 30,
      moreKeywords: 10,
      region: 20,
      exclude: -100,
    });
    expect(MATCH_THRESHOLD).toBe(50);
  });
});

describe("matchOpportunity — categories", () => {
  it("gives +40 once for several profile categories, listing each with its CPV codes", () => {
    const result = matchOpportunity(
      offer({ categories: ["45312100-8", "45310000-3", "72000000-5"] }),
      profile({ categories: ["ppoz", "elektryka", "remonty"] }),
    );
    expect(result.reasons[0]).toEqual({
      kind: "category",
      points: 40,
      hits: [
        { category: "elektryka", cpvCodes: ["45312100-8", "45310000-3"] },
        { category: "ppoz", cpvCodes: ["45312100-8"] },
      ],
    });
  });

  it("names the offer's categories when none is in the profile", () => {
    const result = matchOpportunity(offer({ categories: ["45453000-7"] }), profile());
    expect(result.reasons[0]).toEqual({
      kind: "category_mismatch",
      points: 0,
      offerCategories: ["remonty"],
    });
  });

  it("says that an offer without CPV cannot be checked by category (AC6)", () => {
    const result = matchOpportunity(offer(), profile());
    expect(result.reasons[0]).toEqual({ kind: "category_unverifiable", points: 0, cpvCodes: [] });
  });
});

describe("matchOpportunity — keywords", () => {
  /** Whether the profile keyword is found in the title. */
  function found(keyword: string, title: string): boolean {
    const result = matchOpportunity(offer({ title }), profile({ includeKeywords: [keyword] }));
    return result.reasons.some((reason) => reason.kind === "keyword");
  }

  it.each([
    ["oświetlenie", "Modernizacja OŚWIETLENIA ulicznego"],
    ["oswietlenie", "Oświetlenie boiska"],
    ["Oświetlenie", "oswietlenie boiska"],
    ["żółty", "Farba ZOLTA"],
    ["łączność", "System lacznosci radiowej"],
    ["oświetlenie", "Wymiana oświetleniem"],
    ["instalacja", "Przegląd instalacji gazowej"],
    ["remont", "Wykonanie remontu dachu"],
    ["szkolenie", "Udział w szkoleniach okresowych"],
    ["bhp", "Szkolenia BHP dla pracowników"],
    ["it", "Usługi IT"],
    ["instalacja odgromowa", "Przegląd instalacji odgromowej budynku"],
    ["monitoring", "Monitoring-wizyjny, system"],
    ["oświetlenie", "Wymiana oświe\u00adtlenia w szkole"],
    ["sala", "Wynajem sal konferencyjnych"],
  ])("finds %j in %j", (keyword, title) => {
    expect(found(keyword, title)).toBe(true);
  });

  it.each([
    // Known limitation: the stem changes inside the word.
    ["kabel", "Dostawa kabli i przewodów"],
    ["kabel", "Dostawa kable"],
    ["żłobek", "Remont żłobka nr 3"],
    // Short tokens match only exactly.
    ["bhp", "Odzież bhpowska"],
    ["it", "Item"],
    ["gaz", "Dostawa gazu"],
    // Only at the start of a word.
    ["świetlenie", "Oświetlenie ulic"],
    ["remont", "Przeremontowanie"],
    // A phrase needs consecutive words, in order.
    ["instalacja odgromowa", "Instalacja elektryczna i odgromowa"],
    ["instalacja odgromowa", "Odgromowa instalacja"],
  ])("does not find %j in %j", (keyword, title) => {
    expect(found(keyword, title)).toBe(false);
  });

  it("documents the known over-match of a stem that starts another word", () => {
    // "sala" → stem "sal" also matches "salon", "lampa" → "lamp" also
    // "lampart" (D-023, known limitation).
    expect(found("sala", "Salon fryzjerski")).toBe(true);
    expect(found("lampa", "Lampart")).toBe(true);
  });

  it("searches the description when there is one, and prefers the title", () => {
    const keywords = profile({ includeKeywords: ["oświetlenie", "monitoring"] });
    const result = matchOpportunity(
      offer({ title: "Oświetlenie hali", description: "Oświetlenie oraz monitoring." }),
      keywords,
    );
    expect(result.reasons.filter((reason) => reason.kind === "keyword")).toEqual([
      { kind: "keyword", points: 30, keyword: "oświetlenie", field: "title" },
      { kind: "keyword", points: 0, keyword: "monitoring", field: "description" },
    ]);
    expect(
      kinds(matchOpportunity(offer({ title: "Hala", description: null }), keywords).reasons),
    ).not.toContain("keyword");
  });

  it("counts a keyword written twice in the profile once", () => {
    const result = matchOpportunity(
      offer({ title: "Oświetlenie" }),
      profile({ includeKeywords: ["Oświetlenie", "oswietlenie", " OŚWIETLENIE "] }),
    );
    expect(kinds(result.reasons)).toEqual([
      "category_unverifiable",
      "keyword",
      "region_unrestricted",
    ]);
    expect(result.score).toBe(50);
  });

  it("gives one reason and −100 per excluding keyword found", () => {
    const result = matchOpportunity(
      offer({ title: "Dostawa paliwa", description: "oraz węgla" }),
      profile({ excludeKeywords: ["paliwo", "węgiel", "drewno"] }),
    );
    expect(result.reasons.filter((reason) => reason.kind === "exclude")).toEqual([
      { kind: "exclude", points: -100, keyword: "paliwo", field: "title" },
      // "wegiel" → stem "wegiel" does not match "wegla": a known limitation.
    ]);
    expect(result.score).toBe(-100 + 20);
  });

  it.each([
    ["2024", "Plan na 2024 rok", true],
    ["2024", "Ogłoszenie 20245/2026", false],
    ["1100", "Zakup 11000 sztuk", false],
    ["110 kV", "Linia 110 kV", true],
    ["110 kV", "Linia 1100 kV", false],
  ])(
    "matches a keyword token without a letter only exactly: %j in %j → %j",
    (keyword, title, expected) => {
      expect(found(keyword, title)).toBe(expected);
    },
  );

  it("applies the stem rule to excluding keywords too, over-match included", () => {
    // Known limitation (D-023): exclude "auto" → stem "aut" also removes
    // "Automatyka", a silently lost alert.
    const result = matchOpportunity(
      offer({ title: "Automatyka budynkowa", categories: [ELEKTRYKA_CPV] }),
      profile({ excludeKeywords: ["auto"] }),
    );
    expect(result.reasons).toContainEqual({
      kind: "exclude",
      points: -100,
      keyword: "auto",
      field: "title",
    });
    expect(result.matched).toBe(false);
    // A number in an exclude is exact too.
    expect(
      kinds(
        matchOpportunity(offer({ title: "Dostawa 20245" }), profile({ excludeKeywords: ["2024"] }))
          .reasons,
      ),
    ).not.toContain("exclude");
  });

  it("counts inflected near-duplicates on the same words once", () => {
    const result = matchOpportunity(
      offer({ title: "Oświetlenie" }),
      profile({ includeKeywords: ["oświetlenie", "oświetlenia"] }),
    );
    expect(result.reasons).toEqual([
      { kind: "category_unverifiable", points: 0, cpvCodes: [] },
      { kind: "keyword", points: 30, keyword: "oświetlenie", field: "title" },
      { kind: "region_unrestricted", points: 20 },
    ]);
    expect(result.score).toBe(50);
  });

  it("still counts keywords that cover different words", () => {
    // Overlapping, but not the same words: "oświetlenie" (1 word) and
    // "oświetlenie uliczne" (2 words) are two pieces of evidence.
    const overlapping = matchOpportunity(
      offer({ title: "Oświetlenie uliczne" }),
      profile({ includeKeywords: ["oświetlenie", "oświetlenie uliczne"] }),
    );
    expect(kinds(overlapping.reasons)).toEqual([
      "category_unverifiable",
      "keyword",
      "keyword",
      "more_keywords",
      "region_unrestricted",
    ]);
  });

  it.each([
    [["sala", "salon"], "Remont salonu i sali"],
    [["auto", "automatyka"], "Automatyka i auto"],
    [["salon", "sala"], "Remont salonu i sali"],
  ])("counts every keyword that has evidence of its own: %j in %j", (includeKeywords, title) => {
    const result = matchOpportunity(offer({ title }), profile({ includeKeywords }));
    expect(result.reasons).toEqual([
      { kind: "category_unverifiable", points: 0, cpvCodes: [] },
      { kind: "keyword", points: 30, keyword: includeKeywords[0], field: "title" },
      { kind: "keyword", points: 0, keyword: includeKeywords[1], field: "title" },
      { kind: "more_keywords", points: 10, count: 2 },
      { kind: "region_unrestricted", points: 20 },
    ]);
    expect(result.score).toBe(60);
  });

  it("takes a keyword's evidence from the description when its title words are taken", () => {
    const result = matchOpportunity(
      offer({ title: "Remont salonu", description: "Sala gimnastyczna" }),
      profile({ includeKeywords: ["salon", "sala"] }),
    );
    expect(result.reasons.filter((reason) => reason.kind === "keyword")).toEqual([
      { kind: "keyword", points: 30, keyword: "salon", field: "title" },
      { kind: "keyword", points: 0, keyword: "sala", field: "description" },
    ]);
  });

  it("stays bounded with many keywords sharing the same words", () => {
    // Ten keywords that all hit every word (prefixes of "oswietleniowy"),
    // 90 that hit nothing, 1 000 equal words in the description.
    const word = "oswietleniowy";
    const prefixes = Array.from({ length: 10 }, (_, i) => word.slice(0, i + 4));
    const others = Array.from({ length: 90 }, (_, i) => `brak${String(i)}`);
    const started = performance.now();
    const result = matchOpportunity(
      offer({ title: "x", description: `${word} `.repeat(1_000) }),
      profile({ includeKeywords: [...prefixes, ...others] }),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.reasons.filter((reason) => reason.kind === "keyword")).toHaveLength(10);
    // On a single word, the same ten keywords are one piece of evidence.
    const single = matchOpportunity(offer({ title: word }), profile({ includeKeywords: prefixes }));
    expect(single.reasons.filter((reason) => reason.kind === "keyword")).toHaveLength(1);
  });
});

describe("matchOpportunity — region", () => {
  function region(location: MatchableOpportunity["location"], p: Partial<MatchableProfile>) {
    const reasons = matchOpportunity(offer({ location }), profile(p)).reasons;
    return reasons[reasons.length - 1];
  }

  it("is unrestricted without profile voivodeships and counties (+20)", () => {
    expect(region(null, {})).toEqual({ kind: "region_unrestricted", points: 20 });
  });

  it("matches a voivodeship in any spelling the source uses", () => {
    expect(region({ voivodeship: "woj. Mazowieckie" }, { voivodeships: ["mazowieckie"] })).toEqual({
      kind: "region_match",
      points: 20,
      via: "voivodeship",
      value: "mazowieckie",
    });
    expect(region({ voivodeship: "Slaskie" }, { voivodeships: ["śląskie"] })).toMatchObject({
      kind: "region_match",
      value: "śląskie",
    });
  });

  it("is unknown, not a match, when the offer has no location (AC3)", () => {
    expect(region(null, { voivodeships: ["mazowieckie"] })).toEqual({
      kind: "region_unknown",
      points: 0,
      missing: "location",
    });
    expect(region(null, { counties: ["piaseczyński"] })).toMatchObject({ missing: "location" });
  });

  it("says that the source gives no county when the profile uses counties (AC5)", () => {
    expect(region(MAZOWIECKIE, { counties: ["piaseczyński"] })).toEqual({
      kind: "region_unknown",
      points: 0,
      missing: "county",
    });
    // Voivodeship known but not the profile's, county not given: still unknown.
    expect(
      region({ voivodeship: "śląskie" }, { voivodeships: ["mazowieckie"], counties: ["x"] }),
    ).toMatchObject({ kind: "region_unknown", missing: "county" });
  });

  it("says which part is missing for a location without it", () => {
    expect(region({ city: "Piaseczno" }, { voivodeships: ["mazowieckie"] })).toMatchObject({
      kind: "region_unknown",
      missing: "voivodeship",
    });
    expect(
      region({ raw: "ul. Polna 1" }, { voivodeships: ["mazowieckie"], counties: ["piaseczyński"] }),
    ).toMatchObject({ kind: "region_unknown", missing: "voivodeship_and_county" });
    // A voivodeship the source wrote unrecognisably counts as not given.
    expect(region({ voivodeship: "Mazowsze" }, { voivodeships: ["mazowieckie"] })).toMatchObject({
      kind: "region_unknown",
      missing: "voivodeship",
    });
  });

  it("matches when any region part the profile uses matches", () => {
    expect(
      region(
        { voivodeship: "mazowieckie" },
        { voivodeships: ["mazowieckie"], counties: ["piaseczyński"] },
      ),
    ).toMatchObject({ kind: "region_match", via: "voivodeship" });
    expect(
      region(
        { voivodeship: "śląskie", county: "Powiat Piaseczyński" },
        { voivodeships: ["mazowieckie"], counties: ["piaseczyński"] },
      ),
    ).toEqual({ kind: "region_match", points: 20, via: "county", value: "piaseczyński" });
  });

  it("is a mismatch only when every part the profile uses is known and none matches", () => {
    expect(region({ voivodeship: "śląskie" }, { voivodeships: ["mazowieckie"] })).toEqual({
      kind: "region_mismatch",
      points: 0,
      offerVoivodeship: "śląskie",
      offerCounty: null,
    });
    expect(
      region(
        { voivodeship: "śląskie", county: "powiat gliwicki" },
        { voivodeships: ["mazowieckie"], counties: ["piaseczyński"] },
      ),
    ).toEqual({
      kind: "region_mismatch",
      points: 0,
      offerVoivodeship: "śląskie",
      offerCounty: "gliwicki",
    });
    expect(region({ county: "gliwicki" }, { counties: ["piaseczyński"] })).toMatchObject({
      kind: "region_mismatch",
    });
  });

  it.each([
    ["m. st. Warszawa", "Warszawa"],
    ["m.st. Warszawa", "m. st. Warszawa"],
    ["Warszawa", "M.St. Warszawa"],
    ["miasto stołeczne Warszawa", "m.st. Warszawa"],
    ["powiat m. st. Warszawa", "Warszawa"],
    ["Kraków", "Kraków (miasto na prawach powiatu)"],
    ["piaseczyński", "Powiat  PIASECZYŃSKI"],
    ["pow. piaseczyński", "piaseczynski"],
  ])("compares counties in one form: %j = %j (AC7)", (profileCounty, offerCounty) => {
    expect(countyKey(profileCounty)).toBe(countyKey(offerCounty));
    expect(region({ county: offerCounty }, { counties: [profileCounty] })).toMatchObject({
      kind: "region_match",
      via: "county",
    });
  });

  it.each([
    ["Kraków", "krakowski"],
    ["m. st. Warszawa", "warszawski zachodni"],
    ["piaseczyński", "pruszkowski"],
  ])("keeps different counties different: %j ≠ %j", (profileCounty, offerCounty) => {
    expect(countyKey(profileCounty)).not.toBe(countyKey(offerCounty));
    expect(region({ county: offerCounty }, { counties: [profileCounty] })).toMatchObject({
      kind: "region_mismatch",
    });
  });

  it("has no county key for a text that is no county name", () => {
    expect(countyKey("powiat")).toBeNull();
    expect(countyKey("m. st.")).toBeNull();
    expect(countyKey("  ")).toBeNull();
  });

  it("names a known part outside the profile when another part is unknown (BZP)", () => {
    const both: Partial<MatchableProfile> = {
      voivodeships: ["mazowieckie"],
      counties: ["piaseczyński"],
    };
    const reason = region({ voivodeship: "śląskie" }, both);
    expect(reason).toEqual({
      kind: "region_unknown",
      points: 0,
      missing: "county",
      offerVoivodeship: "śląskie",
    });
    if (reason === undefined) throw new Error("no region reason");
    expect(formatReason(reason)).toBe(
      "region: nieznany — województwo śląskie poza profilem, źródło nie podaje powiatu",
    );
    // A known county outside the profile, voivodeship not given.
    expect(region({ county: "powiat gliwicki" }, both)).toEqual({
      kind: "region_unknown",
      points: 0,
      missing: "voivodeship",
      offerCounty: "gliwicki",
    });
    // A part the profile does not use is not named.
    expect(region({ voivodeship: "śląskie" }, { counties: ["piaseczyński"] })).toEqual({
      kind: "region_unknown",
      points: 0,
      missing: "county",
    });
  });

  it("documents the OR rule for BZP: a county turns out-of-voivodeship offers into unknown", () => {
    const bzpOffer = offer({
      title: "Modernizacja oświetlenia",
      categories: [ELEKTRYKA_CPV],
      location: { voivodeship: "śląskie" },
    });
    const keywords: Partial<MatchableProfile> = {
      includeKeywords: ["oświetlenie"],
      voivodeships: ["mazowieckie"],
    };
    const voivodeshipsOnly = matchOpportunity(bzpOffer, profile(keywords));
    expect(voivodeshipsOnly.reasons.at(-1)?.kind).toBe("region_mismatch");
    expect(voivodeshipsOnly.matched).toBe(false);
    const withCounty = matchOpportunity(
      bzpOffer,
      profile({ ...keywords, counties: ["piaseczyński"] }),
    );
    expect(withCounty.reasons.at(-1)?.kind).toBe("region_unknown");
    expect(withCounty.score).toBe(70);
    expect(withCounty.matched).toBe(true);
    // Without the keyword, category alone (40) is not enough when the region is unknown.
    expect(
      matchOpportunity(bzpOffer, profile({ voivodeships: ["mazowieckie"], counties: ["x"] }))
        .matched,
    ).toBe(false);
  });

  it("keeps a profile entry that does not normalize as a used part that matches nothing", () => {
    expect(region({ voivodeship: "mazowieckie" }, { counties: ["powiat"] })).toMatchObject({
      kind: "region_unknown",
      missing: "county",
    });
    expect(region({ county: "piaseczyński" }, { counties: ["powiat"] })).toMatchObject({
      kind: "region_mismatch",
    });
  });
});

describe("matchOpportunity — invariants", () => {
  const offers = [
    offer({ title: "Oświetlenie", categories: [ELEKTRYKA_CPV], location: MAZOWIECKIE }),
    offer({ title: "Dostawa paliwa", description: "Oświetlenie", location: null }),
    offer({ title: "Monitoring", categories: ["45453000-7"], location: { county: "gliwicki" } }),
    offer({ title: "x", categories: ["45000000-7"], location: { city: "Łódź" } }),
  ];
  const profiles = [
    profile(),
    profile({ includeKeywords: ["oświetlenie", "monitoring"], excludeKeywords: ["paliwo"] }),
    profile({ voivodeships: ["mazowieckie"], counties: ["piaseczyński"] }),
    profile({ categories: ["remonty", "elektryka"], counties: ["gliwicki"] }),
  ];
  const pairs = offers.flatMap((o) => profiles.map((p) => [o, p] as const));

  it("explains the score fully: it is the sum of the reasons' points (AC1)", () => {
    for (const [o, p] of pairs) {
      const result = matchOpportunity(o, p);
      expect(result.score).toBe(result.reasons.reduce((sum, reason) => sum + reason.points, 0));
      const categoryKinds = ["category", "category_mismatch", "category_unverifiable"];
      const regionKinds = ["region_unrestricted", "region_match", "region_mismatch"];
      expect(result.reasons.filter((r) => categoryKinds.includes(r.kind))).toHaveLength(1);
      expect(
        result.reasons.filter((r) => [...regionKinds, "region_unknown"].includes(r.kind)),
      ).toHaveLength(1);
      expect(result.matched).toBe(
        result.score >= MATCH_THRESHOLD &&
          !result.reasons.some((r) => r.kind === "exclude" || r.kind === "region_mismatch"),
      );
    }
  });

  it("is deterministic: the same input gives the same result, reasons in the same order", () => {
    for (const [o, p] of pairs) {
      const first = matchOpportunity(o, p);
      expect(matchOpportunity(structuredClone(o), structuredClone(p))).toEqual(first);
      expect(JSON.stringify(matchOpportunity(o, p))).toBe(JSON.stringify(first));
    }
  });

  it("does not change its input", () => {
    const o = offer({ title: "Oświetlenie", categories: [ELEKTRYKA_CPV], location: MAZOWIECKIE });
    const p = profile({ includeKeywords: ["oświetlenie"], voivodeships: ["mazowieckie"] });
    const before = structuredClone([o, p]);
    matchOpportunity(o, p);
    expect([o, p]).toEqual(before);
  });
});

describe("tokenize / containsKeyword", () => {
  it("splits comparable text on everything that is not a letter or a digit", () => {
    expect(tokenize("Remont (dachu)/elewacji—etap 2; ŁÓDŹ")).toEqual([
      "remont",
      "dachu",
      "elewacji",
      "etap",
      "2",
      "lodz",
    ]);
    expect(tokenize(" ,.; ")).toEqual([]);
  });

  it("stays fast for the longest title and description", () => {
    const words = tokenize("oświetlenie ".repeat(1_000));
    const [keyword] = prepareKeywords(["oświetlenie oświetlenie oświetlenie x"]);
    if (keyword === undefined) throw new Error("no keyword");
    const started = performance.now();
    expect(containsKeyword(words, keyword)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("prepares no keyword without letters or digits", () => {
    expect(prepareKeywords(["--", " "])).toEqual([]);
  });

  it("finds the first position of a keyword", () => {
    const [keyword] = prepareKeywords(["instalacja odgromowa"]);
    if (keyword === undefined) throw new Error("no keyword");
    expect(findKeyword(tokenize("Przegląd: instalacji odgromowej"), keyword)).toBe(1);
    expect(findKeyword(tokenize("Odgromowa instalacja"), keyword)).toBe(-1);
  });

  it.each([
    "oświetlenie",
    "instalacja odgromowa",
    "Remont (dachu)/elewacji—etap 2; ŁÓDŹ",
    "oświe\u00adtlenie uliczne",
    "cafe\u0301 bar",
    "a\u0301\u0301\u0301 b",
    "C++ i .NET",
    "--",
    "İstanbul 110kV",
    "ab\u200bcd ef\u2060gh",
    "1 2 3 4 5 6 7 8 9 10 11",
  ])("counts keyword tokens in the domain as the tokenizer does: %j", (keyword) => {
    expect(keywordTokenCount(keyword)).toBe(tokenize(keyword).length);
  });
});

describe("formatReasons (Polish explanations)", () => {
  it("explains a match in one line", () => {
    const result = matchOpportunity(
      offer({
        title: "Modernizacja oświetlenia ulicznego",
        categories: [ELEKTRYKA_CPV],
        location: MAZOWIECKIE,
      }),
      profile({ includeKeywords: ["oświetlenie"], voivodeships: ["mazowieckie"] }),
    );
    expect(formatReasons(result.reasons)).toBe(
      "kategoria: elektryka (CPV 45310000-3); słowo: oświetlenie (tytuł); region: mazowieckie",
    );
  });

  it.each<[MatchReason, string]>([
    [
      {
        kind: "category",
        points: 40,
        hits: [
          { category: "elektryka", cpvCodes: ["45312100-8", "45310000-3"] },
          { category: "ppoz", cpvCodes: ["45312100-8"] },
        ],
      },
      "kategoria: elektryka (CPV 45312100-8, 45310000-3), ppoz (CPV 45312100-8)",
    ],
    [
      { kind: "category_mismatch", points: 0, offerCategories: ["remonty", "serwis"] },
      "kategoria: niezgodna (oferta: remonty, serwis)",
    ],
    [
      { kind: "category_unverifiable", points: 0, cpvCodes: [] },
      "brak CPV — kategoria niesprawdzalna",
    ],
    [
      { kind: "category_unverifiable", points: 0, cpvCodes: ["45000000-7"] },
      "CPV spoza słownika (45000000-7) — kategoria niesprawdzalna",
    ],
    [
      { kind: "keyword", points: 0, keyword: "monitoring", field: "description" },
      "słowo: monitoring (opis)",
    ],
    [{ kind: "more_keywords", points: 10, count: 2 }, "więcej niż jedno słowo kluczowe (2)"],
    [
      { kind: "exclude", points: -100, keyword: "dostawa paliwa", field: "title" },
      "wykluczone słowem: dostawa paliwa (tytuł)",
    ],
    [{ kind: "region_unrestricted", points: 20 }, "region: bez ograniczeń"],
    [
      { kind: "region_match", points: 20, via: "county", value: "piaseczyński" },
      "region: powiat piaseczyński",
    ],
    [
      { kind: "region_mismatch", points: 0, offerVoivodeship: "śląskie", offerCounty: "gliwicki" },
      "region: poza profilem (oferta: śląskie, powiat gliwicki)",
    ],
    [
      { kind: "region_mismatch", points: 0, offerVoivodeship: null, offerCounty: "gliwicki" },
      "region: poza profilem (oferta: powiat gliwicki)",
    ],
    [
      { kind: "region_unknown", points: 0, missing: "location" },
      "region: nieznany — oferta nie podaje lokalizacji",
    ],
    [
      { kind: "region_unknown", points: 0, missing: "county" },
      "region: nieznany — źródło nie podaje powiatu",
    ],
    [
      { kind: "region_unknown", points: 0, missing: "voivodeship" },
      "region: nieznany — źródło nie podaje województwa",
    ],
    [
      { kind: "region_unknown", points: 0, missing: "voivodeship_and_county" },
      "region: nieznany — źródło nie podaje województwa ani powiatu",
    ],
    [
      { kind: "region_unknown", points: 0, missing: "county", offerVoivodeship: "śląskie" },
      "region: nieznany — województwo śląskie poza profilem, źródło nie podaje powiatu",
    ],
    [
      { kind: "region_unknown", points: 0, missing: "voivodeship", offerCounty: "gliwicki" },
      "region: nieznany — powiat gliwicki poza profilem, źródło nie podaje województwa",
    ],
  ])("formats %j", (reason, expected) => {
    expect(formatReason(reason)).toBe(expected);
  });
});

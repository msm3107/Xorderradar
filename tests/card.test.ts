import { describe, expect, it } from "vitest";
import type { CompanyProfile } from "../src/domain/company-profile.js";
import type { Opportunity } from "../src/domain/opportunity.js";
import { matchOpportunity, type MatchReason } from "../src/matching/match.js";
import {
  formatAmount,
  formatDeadline,
  formatValue,
  matchDetails,
  offerCard,
  SNIPPET_MAX_CHARS,
  whySentence,
  type CardRow,
  type OfferCard,
} from "../src/notifications/card.js";
import { buildDigest } from "../src/notifications/digest.js";
import { matchesPage } from "../src/web/pages.js";

/*
 * PR-11: the offer card shared by the digest, /dopasowania and /przyklad —
 * the value, the deadline counted in Polish calendar days, the "Dlaczego
 * pasuje" sentence, the match details and the description excerpt.
 * Pseudonymised data only.
 */

const NOW = new Date("2026-11-09T09:00:00.000Z");

const profile: CompanyProfile = {
  id: "00000000-0000-4000-8000-0000000000aa",
  email: "kontakt@example.invalid",
  name: "Jan Kowalski Elektryka",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie", "instalacja elektryczna"],
  excludeKeywords: [],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
  createdAt: new Date("2026-10-01T08:00:00.000Z"),
  updatedAt: new Date("2026-10-01T08:00:00.000Z"),
};

function offer(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sourceId: "bzp",
    sourceUrl: "https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1",
    externalId: "2026/BZP 1",
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: "Modernizacja oświetlenia ulicznego",
    description: "Wymiana opraw na LED.",
    location: { city: "Przykładowo", voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-11-06T08:00:00.000Z"),
    deadline: new Date("2026-11-18T09:00:00.000Z"),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: null,
    fetchedAt: new Date("2026-11-06T09:00:00.000Z"),
    fingerprint: "fp-1",
    contentHash: "hash-1",
    status: "open",
    firstSeenAt: new Date("2026-11-06T09:00:00.000Z"),
    updatedAt: new Date("2026-11-06T09:00:00.000Z"),
    ...overrides,
  };
}

function card(overrides: Partial<Opportunity> = {}, now = NOW) {
  const value = offer(overrides);
  return offerCard({ offer: value, reasons: matchOpportunity(value, profile).reasons }, now);
}

/** Every labelled row of a card, in its order. */
function allRows(value: OfferCard): CardRow[] {
  return [...value.lead, ...value.body, ...value.more];
}

describe("value (PR-11)", () => {
  it.each([
    ["120000.00", "PLN", "120 000,00 PLN"],
    ["0", "PLN", "0,00 PLN"],
    ["5", "PLN", "5,00 PLN"],
    ["999", "PLN", "999,00 PLN"],
    ["1000", "PLN", "1 000,00 PLN"],
    ["1234567.5", "EUR", "1 234 567,50 EUR"],
    ["12.3400", "PLN", "12,34 PLN"],
    // Four decimals are kept: rounding would change the published amount.
    ["0.1234", "PLN", "0,1234 PLN"],
    // Beyond a float's 15–17 significant digits: built from the string, digit by digit.
    ["999999999999999.9999", "PLN", "999 999 999 999 999,9999 PLN"],
  ])("formats %s %s as „%s”", (value, currency, expected) => {
    expect(formatAmount(value, currency)).toBe(expected);
  });

  it("says the source does not give net or gross (D-030), and „nie podano” without a value", () => {
    expect(formatValue("120000.00", "PLN")).toBe(
      "120 000,00 PLN (źródło nie podaje, netto czy brutto)",
    );
    expect(formatValue(null, null)).toBe("nie podano");
    expect(card().lead[0]).toEqual({
      label: "Wartość szacunkowa",
      value: "nie podano",
      urgent: false,
    });
    expect(card({ estimatedValue: "48500.00", currency: "PLN" }).lead[0]?.value).toBe(
      "48 500,00 PLN (źródło nie podaje, netto czy brutto)",
    );
  });
});

describe("deadline (PR-11)", () => {
  const at = (iso: string) => new Date(iso);

  it("shows the day, weekday and time in Poland and the days left", () => {
    expect(formatDeadline(at("2026-11-18T09:00:00.000Z"), NOW)).toEqual({
      text: "18.11.2026 (śr) 10:00 — za 9 dni",
      urgent: false,
    });
    // Zero-padded day, month, hour and minute.
    expect(
      formatDeadline(at("2026-01-05T08:05:00.000Z"), at("2026-01-01T08:00:00.000Z")).text,
    ).toBe("05.01.2026 (pn) 09:05 — za 4 dni");
  });

  it.each([
    ["2026-11-09T12:00:00.000Z", "09.11.2026 (pn) 13:00 — dziś"],
    ["2026-11-10T12:00:00.000Z", "10.11.2026 (wt) 13:00 — jutro"],
    ["2026-11-11T12:00:00.000Z", "11.11.2026 (śr) 13:00 — za 2 dni"],
    ["2026-11-12T12:00:00.000Z", "12.11.2026 (czw) 13:00 — za 3 dni"],
    ["2026-11-13T12:00:00.000Z", "13.11.2026 (pt) 13:00 — za 4 dni"],
    ["2026-11-14T12:00:00.000Z", "14.11.2026 (sob) 13:00 — za 5 dni"],
    ["2026-11-15T12:00:00.000Z", "15.11.2026 (nd) 13:00 — za 6 dni"],
  ])("names every weekday from the fixed table: %s", (deadline, text) => {
    expect(formatDeadline(at(deadline), NOW).text).toBe(text);
  });

  it("marks 0–2 days as urgent, 3 days and more not", () => {
    const urgent = (iso: string) => formatDeadline(at(iso), NOW).urgent;
    expect(urgent("2026-11-09T12:00:00.000Z")).toBe(true);
    expect(urgent("2026-11-10T12:00:00.000Z")).toBe(true);
    expect(urgent("2026-11-11T22:59:00.000Z")).toBe(true);
    // 3 calendar days, though less than 72 hours away.
    expect(urgent("2026-11-12T06:00:00.000Z")).toBe(false);
  });

  it("counts calendar days across midnight in Poland, not 24-hour periods", () => {
    // 23:59:59 vs 00:00:01 the next day (CET): two seconds, "jutro".
    expect(formatDeadline(at("2026-11-09T23:00:01.000Z"), at("2026-11-09T22:59:59.000Z"))).toEqual({
      text: "10.11.2026 (wt) 00:00 — jutro",
      urgent: true,
    });
    // Exactly 00:00 the next day.
    expect(
      formatDeadline(at("2026-11-09T23:00:00.000Z"), at("2026-11-09T22:59:59.000Z")).text,
    ).toBe("10.11.2026 (wt) 00:00 — jutro");
    // Rendered at 00:00 exactly: a deadline at 23:59 is still today.
    expect(
      formatDeadline(at("2026-11-10T22:59:00.000Z"), at("2026-11-09T23:00:00.000Z")).text,
    ).toBe("10.11.2026 (wt) 23:59 — dziś");
    // A deadline at the very render time has not passed.
    expect(formatDeadline(NOW, NOW)).toEqual({
      text: "09.11.2026 (pn) 10:00 — dziś",
      urgent: true,
    });
  });

  it("handles the spring DST change (29.03.2026, 02:00 CET → 03:00 CEST)", () => {
    // Rendered on Saturday 23:30 CET, deadline on Sunday 10:00 CEST.
    const saturdayNight = at("2026-03-28T22:30:00.000Z");
    expect(formatDeadline(at("2026-03-29T08:00:00.000Z"), saturdayNight)).toEqual({
      text: "29.03.2026 (nd) 10:00 — jutro",
      urgent: true,
    });
    // Before the change, deadline after it: 3 calendar days in under 72 hours.
    expect(formatDeadline(at("2026-03-30T08:00:00.000Z"), at("2026-03-27T10:00:00.000Z"))).toEqual({
      text: "30.03.2026 (pn) 10:00 — za 3 dni",
      urgent: false,
    });
    // Both after the change.
    expect(
      formatDeadline(at("2026-03-29T22:30:00.000Z"), at("2026-03-29T08:00:00.000Z")).text,
    ).toBe("30.03.2026 (pn) 00:30 — jutro");
    // Both before the change: 01:59 CET on the day itself.
    expect(
      formatDeadline(at("2026-03-29T00:59:00.000Z"), at("2026-03-28T23:30:00.000Z")).text,
    ).toBe("29.03.2026 (nd) 01:59 — dziś");
  });

  it("handles the autumn DST change (25.10.2026, 03:00 CEST → 02:00 CET)", () => {
    // Rendered on Saturday 23:30 CEST; Sunday 23:59 CET is 25 hours later, still "jutro".
    const saturdayNight = at("2026-10-24T21:30:00.000Z");
    expect(formatDeadline(at("2026-10-25T22:59:00.000Z"), saturdayNight)).toEqual({
      text: "25.10.2026 (nd) 23:59 — jutro",
      urgent: true,
    });
    // Monday 00:30 CET: 2 calendar days.
    expect(formatDeadline(at("2026-10-25T23:30:00.000Z"), saturdayNight).text).toBe(
      "26.10.2026 (pn) 00:30 — za 2 dni",
    );
    // 02:30 occurs twice that night: both instants show their wall time.
    const sunday = at("2026-10-24T22:30:00.000Z");
    expect(formatDeadline(at("2026-10-25T00:30:00.000Z"), sunday).text).toBe(
      "25.10.2026 (nd) 02:30 — dziś",
    );
    expect(formatDeadline(at("2026-10-25T01:30:00.000Z"), sunday).text).toBe(
      "25.10.2026 (nd) 02:30 — dziś",
    );
    // Rendered after the change, deadline a week later in CET.
    expect(
      formatDeadline(at("2026-11-01T09:00:00.000Z"), at("2026-10-25T09:00:00.000Z")).text,
    ).toBe("01.11.2026 (nd) 10:00 — za 7 dni");
  });

  it("says a passed deadline has passed, also earlier the same day, and never marks it urgent", () => {
    // Rendered at 14:00, deadline at 10:00 that day.
    expect(formatDeadline(at("2026-11-10T09:00:00.000Z"), at("2026-11-10T13:00:00.000Z"))).toEqual({
      text: "10.11.2026 (wt) 10:00 — minął",
      urgent: false,
    });
    // One second late.
    expect(
      formatDeadline(at("2026-11-10T09:00:00.000Z"), at("2026-11-10T09:00:01.000Z")).text,
    ).toBe("10.11.2026 (wt) 10:00 — minął");
    expect(formatDeadline(at("2026-11-01T09:00:00.000Z"), NOW)).toEqual({
      text: "01.11.2026 (nd) 10:00 — minął",
      urgent: false,
    });
  });

  it("shows a missing deadline as „nie podano”, never urgent", () => {
    expect(formatDeadline(null, NOW)).toEqual({ text: "nie podano", urgent: false });
  });
});

describe("why it matches (PR-11)", () => {
  it("is one sentence: category names, each keyword and where, the region", () => {
    const value = offer({
      title: "Modernizacja oświetlenia",
      description: "Przebudowa obejmuje instalacja elektryczna zasilania.",
    });
    const { reasons } = matchOpportunity(value, profile);
    expect(whySentence(reasons)).toBe(
      "Elektryka · słowo „oświetlenie” w tytule · słowo „instalacja elektryczna” w opisie · " +
        "mazowieckie",
    );
  });

  it("names a county match as a county", () => {
    const reasons: MatchReason[] = [
      { kind: "keyword", points: 30, keyword: "oświetlenie", field: "title" },
      { kind: "region_match", points: 20, via: "county", value: "warszawski zachodni" },
    ];
    expect(whySentence(reasons)).toBe("słowo „oświetlenie” w tytule · powiat warszawski zachodni");
  });

  it("falls back to the technical reasons rather than an empty line", () => {
    expect(whySentence([{ kind: "region_unrestricted", points: 20 }])).toBe(
      "region: bez ograniczeń",
    );
    expect(whySentence([])).toBe("nie podano");
  });

  it("leaves the scoring alone: the card shows the reasons matchOpportunity made", () => {
    const value = offer();
    const result = matchOpportunity(value, profile);
    const before = JSON.stringify(result);
    offerCard({ offer: value, reasons: result.reasons }, NOW);
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe("match details (PR-11)", () => {
  it("lists the CPV codes and the technical reasons, never the human ones again", () => {
    // The city only: the region is unknown.
    const value = offer({ location: { city: "Wzorowo" } });
    expect(matchDetails(value, matchOpportunity(value, profile).reasons)).toEqual([
      "CPV: 45310000-3",
      "region: nieznany — źródło nie podaje województwa",
    ]);
  });

  it("says a CPV code outside the vocabulary leaves the category unverifiable, codes once", () => {
    const value = offer({ categories: ["71320000-7"] });
    expect(matchDetails(value, matchOpportunity(value, profile).reasons)).toEqual([
      "CPV: 71320000-7",
      "kod CPV spoza naszej listy kategorii — kategorii nie da się sprawdzić",
    ]);
  });

  it("leaves out „more keywords”: each keyword is in the „Dlaczego pasuje” sentence already", () => {
    const value = offer({
      title: "Oświetlenie i instalacja elektryczna w szkole",
      description: null,
    });
    const { reasons } = matchOpportunity(value, profile);
    // The scoring still has the reason; only the card does not repeat it.
    expect(reasons.map((reason) => reason.kind)).toContain("more_keywords");
    expect(matchDetails(value, reasons)).toEqual(["CPV: 45310000-3"]);
    expect(whySentence(reasons)).toBe(
      "Elektryka · słowo „oświetlenie” w tytule · słowo „instalacja elektryczna” w tytule · mazowieckie",
    );
  });

  it("names the offer's other categories, but a category mismatch only in its reason", () => {
    // 45310000-3 electrical work; 90910000-9 cleaning.
    const both = offer({ categories: ["45310000-3", "90910000-9"] });
    expect(matchDetails(both, matchOpportunity(both, profile).reasons)).toEqual([
      "Inna kategoria ogłoszenia: Sprzątanie",
      "CPV: 45310000-3, 90910000-9",
    ]);
    const cleaning = offer({ categories: ["90910000-9"] });
    expect(matchDetails(cleaning, matchOpportunity(cleaning, profile).reasons)).toEqual([
      "CPV: 90910000-9",
      "kategoria: niezgodna (oferta: „Sprzątanie”)",
    ]);
  });
});

describe("offerCard (PR-11)", () => {
  it("groups the rows in the one order every renderer shows (owner's review of PR #17)", () => {
    const bk = card({
      sourceId: "bk",
      estimatedValue: "120000.00",
      currency: "PLN",
      contact: { email: "zamowienia@example.invalid", phone: "000 000 000" },
    });
    expect(bk.title).toBe("Modernizacja oświetlenia ulicznego");
    // How much, until when and why first; then the button (url); then the rest.
    expect(bk.lead.map((row) => row.label)).toEqual([
      "Wartość szacunkowa",
      "Termin składania ofert",
      "Dlaczego pasuje",
    ]);
    expect(bk.url).toBe("https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1");
    // The attribution stays with the visible body, never among the folded rows.
    expect(bk.body.map((row) => row.label)).toEqual([
      "Zamawiający",
      "Lokalizacja",
      "Opis",
      "Źródło",
    ]);
    expect(bk.more.map((row) => row.label)).toEqual(["Data publikacji", "Kontakt"]);
    expect(bk.more.find((row) => row.label === "Data publikacji")?.value).toBe("06.11.2026");
    expect(bk.more.find((row) => row.label === "Kontakt")?.value).toBe(
      "zamowienia@example.invalid, 000 000 000",
    );
    expect(bk.matchDetails).toEqual(["CPV: 45310000-3"]);
  });

  it("keeps a missing publication date in the card as not given", () => {
    expect(card({ publishedAt: null }).more).toEqual([
      { label: "Data publikacji", value: "nie podano", urgent: false },
    ]);
  });

  it("marks only the deadline row urgent", () => {
    const soon = card({ deadline: new Date("2026-11-10T09:00:00.000Z") });
    expect(
      allRows(soon)
        .filter((row) => row.urgent)
        .map((row) => row.label),
    ).toEqual(["Termin składania ofert"]);
    expect(allRows(card()).some((row) => row.urgent)).toBe(false);
  });

  it("keeps a short description whole, with no full text to unfold", () => {
    const short = card();
    expect(short.body.find((row) => row.label === "Opis")?.value).toBe("Wymiana opraw na LED.");
    expect(short.fullDescription).toBeNull();
    const exact = "a".repeat(SNIPPET_MAX_CHARS);
    expect(card({ description: exact }).fullDescription).toBeNull();
  });

  it("cuts a long description at a word boundary and keeps the whole one apart", () => {
    const words = Array.from({ length: 80 }, (_, index) => `słowo${String(index)}`).join(" ");
    const long = card({ description: `  ${words}\n` });
    const excerpt = long.body.find((row) => row.label === "Opis")?.value ?? "";
    expect(excerpt.endsWith("…")).toBe(true);
    expect(Array.from(new Intl.Segmenter().segment(excerpt)).length).toBeLessThanOrEqual(
      SNIPPET_MAX_CHARS,
    );
    expect(words.startsWith(excerpt.slice(0, -1))).toBe(true);
    expect(words.charAt(excerpt.length - 1)).toBe(" ");
    expect(long.fullDescription).toBe(words);
  });

  it("leaves out a missing description and contact, and says a missing link is not given", () => {
    const bare = card({ description: null, contact: null, sourceUrl: "javascript:alert(1)" });
    expect(allRows(bare).map((row) => row.label)).not.toContain("Opis");
    expect(allRows(bare).map((row) => row.label)).not.toContain("Kontakt");
    expect(bare.url).toBeNull();
    // Where the button would be: the lead's last row.
    expect(bare.lead.at(-1)).toEqual({ label: "Link", value: "nie podano", urgent: false });
    expect(allRows(bare).filter((row) => row.label === "Link")).toHaveLength(1);
    expect(allRows(card()).map((row) => row.label)).not.toContain("Link");
    expect(bare.fullDescription).toBeNull();
  });

  it("cleans line breaks and control characters out of every value", () => {
    const messy = card({
      title: "Tytuł\r\nz łamaniem",
      issuerName: "Gmina\u0000 Przykładowa",
      description: "Opis\tz\ttabulatorami",
    });
    expect(messy.title).toBe("Tytuł z łamaniem");
    for (const row of allRows(messy)) expect(row.value).not.toMatch(/[\p{Cc}]/u);
  });
});

describe("the same card in the e-mail and on /dopasowania (PR-11 AC3)", () => {
  /** Tags dropped and the escapes undone: what a reader sees. */
  function visible(html: string): string {
    return html
      .replace(/<[^>]*>/g, "")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  }

  it.each([
    ["with a link", "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/1?a=1&b=2"],
    ["without a usable link", "javascript:alert(1)"],
  ])("shows the same content, in the same order, in every renderer (%s)", (_case, sourceUrl) => {
    // Every row present, an urgent deadline (tomorrow) and characters that need escaping.
    const value = offer({
      sourceId: "bk",
      sourceUrl,
      estimatedValue: "120000.00",
      currency: "PLN",
      deadline: new Date("2026-11-10T09:00:00.000Z"),
      description: "Wymiana opraw <LED> & „słupów”",
      contact: { name: "Anna Nowak", email: "zamowienia@example.invalid" },
    });
    const item = { offer: value, reasons: matchOpportunity(value, profile).reasons };
    const model = offerCard(item, NOW);
    const pairs = (rows: readonly CardRow[]) =>
      rows.map((row) => [row.label, row.urgent ? `PILNE ${row.value}` : row.value]);
    // The card's order: lead, the button (when there is a link), body, more, the match details.
    const expected = [
      ...pairs(model.lead),
      ...(model.url === null ? [] : [["Otwórz ogłoszenie", model.url]]),
      ...pairs(model.body),
      ...pairs(model.more),
      ["Szczegóły dopasowania", model.matchDetails.join(" · ")],
    ];
    expect(expected.map(([label]) => label)).toContain("Źródło");
    expect(expected.map(([label]) => label)).toContain("Kontakt");
    expect(expected[1]?.[1]).toMatch(/^PILNE /u);
    expect(expected[3]?.[0]).toBe(model.url === null ? "Link" : "Otwórz ogłoszenie");

    const { text, html } = buildDigest(profile, [item], NOW, { overflow: 0 });
    const lines = text.split("\n");
    const titleAt = lines.indexOf("1. Modernizacja oświetlenia ulicznego");
    const textRows = lines
      .slice(titleAt + 1, lines.indexOf("", titleAt))
      .map((line) => /^ {3}([^:]+): (.*)$/u.exec(line)?.slice(1, 3));
    expect(textRows).toEqual(expected);

    // A row's line, the button or the small match details, in document order.
    const mailCard = /<div style="border[^>]*>(.*?)<\/div>/su.exec(html)?.[1] ?? "";
    const mailRows = [
      ...mailCard.matchAll(
        /<b>([^<]*?):<\/b> (.*?)(?=<br>|<\/p>)|<a href="([^"]*)"[^>]*><b>([^<]*)<\/b><\/a>|<small>([^:<]*): (.*?)<\/small>/gsu,
      ),
    ].map((match) =>
      (match[1] !== undefined
        ? [match[1], match[2] ?? ""]
        : match[3] !== undefined
          ? [match[4] ?? "", match[3]]
          : [match[5] ?? "", match[6] ?? ""]
      ).map(visible),
    );
    expect(mailRows).toEqual(expected);

    const page = matchesPage({
      active: true,
      hasVoivodeships: true,
      hasCounties: false,
      stateAt: "2026-11-09 10:00",
      windowDays: 7,
      items: [model],
      more: 0,
      truncated: false,
    }).html;
    const pageCard = /<article>(.*?)<\/article>/su.exec(page)?.[1] ?? "";
    const pageRows = [
      ...pageCard.matchAll(
        /<dt>(.*?):<\/dt><dd>(.*?)<\/dd>|<a class="button" href="([^"]*)"[^>]*>(.*?)<\/a>/gsu,
      ),
    ].map((match) =>
      (match[1] !== undefined
        ? [match[1], (match[2] ?? "").replace(/<\/li><li>/g, " · ")]
        : [match[4] ?? "", match[3] ?? ""]
      ).map(visible),
    );
    expect(pageRows).toEqual(expected);
  });
});

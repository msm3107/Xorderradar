import { setImmediate as onNextLoop } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyProfile } from "../src/domain/company-profile.js";
import type { Opportunity } from "../src/domain/opportunity.js";
import { matchOpportunity } from "../src/matching/match.js";
import { MATCH_YIELD_AFTER_MS, matchingItems } from "../src/notifications/candidates.js";
import {
  buildDigest,
  digestSubject,
  escapeHtml,
  newCount,
  SNIPPET_MAX_CHARS,
  snippet,
  type DigestItem,
} from "../src/notifications/digest.js";

const NOW = new Date("2026-11-01T06:00:00.000Z");

// Pseudonymised data only.
const profile: CompanyProfile = {
  id: "00000000-0000-4000-8000-0000000000aa",
  email: "kontakt@example.invalid",
  name: "Jan Kowalski Elektryka",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie"],
  excludeKeywords: [],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
  createdAt: new Date("2026-10-01T08:00:00.000Z"),
  updatedAt: new Date("2026-10-01T08:00:00.000Z"),
};

let sequence = 0;
function offer(overrides: Partial<Opportunity> = {}): Opportunity {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sourceId: "bzp",
    sourceUrl: `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/${String(sequence)}`,
    externalId: `2026/BZP ${String(sequence)}`,
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: `Modernizacja oświetlenia ulicznego ${String(sequence)}`,
    description: "Wymiana opraw oświetleniowych na LED.",
    location: { city: "Przykładowo", voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-10-30T08:00:00.000Z"),
    deadline: new Date("2026-11-05T11:00:00.000Z"),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: { name: "Jan Kowalski", email: "kontakt@example.invalid", phone: "000 000 000" },
    fetchedAt: new Date("2026-10-30T09:00:00.000Z"),
    fingerprint: `fp-${String(sequence)}`,
    contentHash: `hash-${String(sequence)}`,
    status: "open",
    firstSeenAt: new Date("2026-10-30T09:00:00.000Z"),
    updatedAt: new Date("2026-10-30T09:00:00.000Z"),
    ...overrides,
  };
}

function item(overrides: Partial<Opportunity> = {}): DigestItem {
  const value = offer(overrides);
  return { offer: value, reasons: matchOpportunity(value, profile).reasons };
}

function digest(items: DigestItem[], overflow = 0) {
  return buildDigest(profile, items, NOW, { overflow });
}

describe("buildDigest", () => {
  it("shows every field the source gave, in text and HTML", () => {
    const one = item({ title: "Modernizacja oświetlenia w szkole" });
    const { subject, text, html } = digest([one]);
    expect(subject).toBe("Radar Zamówień: 1 nowe, najbliższy termin 05.11");
    const lines = [
      "Znaleźliśmy dziś 1 nowe zamówienie pasujące do Twojej firmy.",
      "1. Modernizacja oświetlenia w szkole",
      "   Wartość szacunkowa: nie podano",
      "   Termin składania ofert: 05.11.2026 (czw) 12:00 — za 4 dni",
      "   Zamawiający: Gmina Przykładowa",
      "   Lokalizacja: Przykładowo, woj. mazowieckie",
      "   Data publikacji: 30.10.2026",
      "   Kontakt: Jan Kowalski, kontakt@example.invalid, 000 000 000",
      "   Dlaczego pasuje: Elektryka · słowo „oświetlenie” w tytule · mazowieckie",
      "   Opis: Wymiana opraw oświetleniowych na LED.",
      `   Link: ${one.offer.sourceUrl}`,
      "   Szczegóły dopasowania: CPV: 45310000-3",
    ];
    // In this order, one card: the title, the rows, the link, the details last.
    const textLines = text.split("\n");
    const at = textLines.indexOf(lines[1] ?? "");
    expect(textLines.slice(at - 2, at + lines.length - 1)).toEqual([
      lines[0],
      "",
      ...lines.slice(1),
    ]);
    // The same content in the HTML part (the link is the button, below).
    for (const line of lines.slice(1, -2)) {
      const value = line.replace(/^ *(?:\d+\. |[^:]+: )/u, "");
      expect(html).toContain(escapeHtml(value));
    }
    expect(html).toContain("<small>Szczegóły dopasowania: CPV: 45310000-3</small>");
    expect(html).toContain(
      `<a href="${one.offer.sourceUrl}" style="display:inline-block;padding:6px 14px;` +
        'background:#1d5fb4;color:#fff;text-decoration:none"><b>Otwórz ogłoszenie</b></a>',
    );
  });

  it("says why the e-mail comes and how to unsubscribe, in both parts", () => {
    const { text, html } = digest([item()]);
    for (const part of [text, html]) {
      expect(part).toContain("Otrzymujesz tę wiadomość, ponieważ dla firmy");
      expect(part).toContain("Jan Kowalski Elektryka");
      expect(part).toContain("Aby zrezygnować z powiadomień, odpowiedz na tę wiadomość");
      expect(part).toContain("Stan na 2026-11-01 07:00 (czas polski).");
      expect(part).toContain(
        "Termin mógł się zmienić, a postępowanie mogło zostać odwołane — przed złożeniem " +
          "oferty sprawdź ogłoszenie w źródle.",
      );
    }
  });

  it("marks missing values as not given and leaves out optional ones", () => {
    const { text } = digest([
      item({
        location: null,
        deadline: null,
        publishedAt: null,
        description: null,
        contact: null,
        categories: [],
      }),
    ]);
    expect(text).toContain("   Wartość szacunkowa: nie podano\n");
    expect(text).toContain("   Lokalizacja: nie podano\n");
    expect(text).toContain("   Termin składania ofert: nie podano\n");
    expect(text).toContain("   Data publikacji: nie podano\n");
    // No CPV code: the details say so, among the technical reasons.
    expect(text).toContain(
      "   Szczegóły dopasowania: kategoria: ogłoszenie nie podaje kodu CPV · " +
        "region: nieznany — oferta nie podaje lokalizacji\n",
    );
    expect(text).not.toContain("CPV: ");
    expect(text).not.toContain("Opis:");
    expect(text).not.toContain("Kontakt:");
    // Never an invented value.
    expect(text).not.toMatch(/: 0\n|1970/);
  });

  it("shows the raw location or contact when it could not be split", () => {
    const { text } = digest([
      item({
        location: { raw: "ul. Przykładowa 1, Przykładowo" },
        contact: { raw: "sekretariat" },
      }),
    ]);
    expect(text).toContain("   Lokalizacja: ul. Przykładowa 1, Przykładowo\n");
    expect(text).toContain("   Kontakt: sekretariat\n");
  });

  it("shows CPV codes outside the MVP vocabulary, and counts the codes beyond five", () => {
    const { text } = digest([
      item({
        categories: [
          "03000000-1",
          "09000000-3",
          "14000000-1",
          "15000000-8",
          "16000000-5",
          "18000000-9",
        ],
      }),
    ]);
    expect(text).toContain(
      "   Szczegóły dopasowania: CPV: 03000000-1, 09000000-3, 14000000-1, 15000000-8, " +
        "16000000-5 i 1 inny · kod CPV spoza naszej listy kategorii — kategorii nie da się sprawdzić\n",
    );
  });

  it("attributes a Baza Konkurencyjności offer as its terms require, in both parts (D-030)", () => {
    const bk = item({
      sourceId: "bk",
      sourceUrl: "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296920",
      externalId: "296920",
      contact: { email: "kontakt@example.invalid" },
      // Late on 3 November in UTC is already 4 November in Poland.
      fetchedAt: new Date("2026-11-03T23:30:00.000Z"),
    });
    const attribution =
      "Baza Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej; pobrano 2026-11-04; " +
      "dane przetworzone: skrócone i ujednolicone";
    const { text, html } = digest([bk]);
    const lines = text.split("\n");
    const at = lines.indexOf(`   Źródło: ${attribution}`);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at - 1]).toMatch(/^ {3}Opis: /u);
    expect(lines[at + 1]).toBe(`   Link: ${bk.offer.sourceUrl}`);
    expect(html).toContain(escapeHtml(attribution));

    // BZP offers carry no such line (D-015): their output is unchanged.
    const bzp = digest([item()]);
    expect(bzp.text).not.toContain("Źródło:");
    expect(bzp.html).not.toContain("Źródło");
  });

  it("marks a deadline 0–2 days away with PILNE in both parts, and only that offer (PR-11)", () => {
    // NOW is Sunday 01.11 07:00 in Poland: Monday 02.11 10:00 is "jutro".
    const urgent = item({ title: "Pilne", deadline: new Date("2026-11-02T09:00:00.000Z") });
    const calm = item({ title: "Spokojne" });
    const { text, html } = digest([calm, urgent]);
    const lines = text.split("\n");
    const urgentAt = lines.indexOf("1. Pilne");
    const calmAt = lines.indexOf("2. Spokojne");
    expect(urgentAt).toBeGreaterThanOrEqual(0);
    expect(calmAt).toBeGreaterThan(urgentAt);
    expect(lines[urgentAt + 2]).toBe(
      "   Termin składania ofert: PILNE 02.11.2026 (pn) 10:00 — jutro",
    );
    expect(lines[calmAt + 2]).toBe("   Termin składania ofert: 05.11.2026 (czw) 12:00 — za 4 dni");
    expect(html).toContain(
      '<b>Termin składania ofert:</b> <b style="background:#b3261e;color:#fff;padding:0 4px">' +
        "PILNE</b> 02.11.2026 (pn) 10:00 — jutro",
    );
    expect(html).toContain("<b>Termin składania ofert:</b> 05.11.2026 (czw) 12:00 — za 4 dni");
    // The word once per part: the calm offer's card has none.
    expect(text.match(/PILNE/g)).toHaveLength(1);
    expect(html.match(/PILNE/g)).toHaveLength(1);
    expect(lines.slice(calmAt).join("\n")).not.toContain("PILNE");
    expect(html.slice(html.indexOf(">Spokojne</h2>"))).not.toContain("PILNE");
  });

  it("sorts by deadline, soonest first, unknown last", () => {
    const later = item({ title: "Później", deadline: new Date("2026-11-20T10:00:00.000Z") });
    const none = item({ title: "Bez terminu", deadline: null });
    const sooner = item({ title: "Wcześniej", deadline: new Date("2026-11-03T10:00:00.000Z") });
    const { text } = digest([later, none, sooner]);
    expect(text.match(/^\d+\. .*$/gmu)).toEqual(["1. Wcześniej", "2. Później", "3. Bez terminu"]);
  });

  it.each([
    [2, "2 nowe zamówienia pasujące", "2 nowe"],
    [5, "5 nowych zamówień pasujących", "5 nowych"],
    [12, "12 nowych zamówień pasujących", "12 nowych"],
    [22, "22 nowe zamówienia pasujące", "22 nowe"],
  ])("uses the Polish plural for %i offers", (count, heading, subject) => {
    const { text, subject: actual } = digest(Array.from({ length: count }, () => item()));
    expect(text.startsWith(`Znaleźliśmy dziś ${heading} do Twojej firmy.\n`)).toBe(true);
    expect(actual).toBe(`Radar Zamówień: ${subject}, najbliższy termin 05.11`);
  });

  it.each([
    [1, "1 kolejne pasujące zamówienie wyślemy w następnych dniach, jeśli będzie wtedy aktualne."],
    [2, "2 kolejne pasujące zamówienia wyślemy w następnych dniach, jeśli będą wtedy aktualne."],
    [5, "5 kolejnych pasujących zamówień wyślemy w następnych dniach, jeśli będą wtedy aktualne."],
  ])("tells right under the heading that %i matching offers did not fit", (overflow, notice) => {
    const { text, html } = digest([item()], overflow);
    expect(
      text.startsWith(
        `Znaleźliśmy dziś 1 nowe zamówienie pasujące do Twojej firmy.\n\n${notice}\n\n1. `,
      ),
    ).toBe(true);
    expect(html).toContain(
      `<p><strong>${escapeHtml("Znaleźliśmy dziś 1 nowe zamówienie pasujące do Twojej firmy.")}` +
        `</strong></p>\n<p>${escapeHtml(notice)}</p>\n<div style=`,
    );
  });

  it("says nothing about overflow when everything fitted", () => {
    const { text, html } = digest([item()], 0);
    expect(text).not.toContain("wyślemy w następnych dniach");
    expect(html).not.toContain("wyślemy w następnych dniach");
  });

  it("keeps source text and the profile name out of the subject, and line breaks out of the name", () => {
    const hostileProfile = { name: "Firma\r\nBcc: x@example.invalid" };
    const { subject, text } = buildDigest(
      hostileProfile,
      [item({ title: "Tytuł ze źródła" })],
      NOW,
      { overflow: 0 },
    );
    expect(subject).toBe("Radar Zamówień: 1 nowe, najbliższy termin 05.11");
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).not.toContain("Tytuł ze źródła");
    expect(subject).not.toContain("Firma");
    // The footer names the profile, cleaned of the line break.
    expect(text).toContain("dla firmy „Firma Bcc: x@example.invalid” założono profil");
  });

  it("escapes hostile source text and drops non-http links (AC3)", () => {
    const hostile = `<script>alert("x")</script> ' \` <img src=x onerror=alert(1)>`;
    const { text, html } = digest([
      item({
        title: hostile,
        issuerName: `Gmina "Cudzysłów" & 'Apostrof' \`backtick\``,
        description: hostile,
        location: { raw: hostile },
        contact: { raw: hostile },
        sourceUrl: "javascript:alert(1)",
      }),
    ]);
    expect(html).not.toMatch(/<script|<img|onerror=alert\(1\)>|javascript:/i);
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39; &#96;");
    expect(html).toContain(
      "Gmina &quot;Cudzysłów&quot; &amp; &#39;Apostrof&#39; &#96;backtick&#96;",
    );
    expect(html).not.toContain("<a ");
    expect(text).toContain("   Link: nie podano\n");
    expect(html).toContain("<br><b>Link:</b> nie podano</p>");
    expect(html).not.toContain("Otwórz ogłoszenie");
    expect(text).not.toContain("javascript:");
  });

  it.each([
    ["a data: URL", "data:text/html,<script>alert(1)</script>"],
    ["a vbscript: URL", "vbscript:msgbox(1)"],
    ["a relative URL", "/notice/1"],
  ])("shows no link for %s, only that it is not given", (_case, sourceUrl) => {
    const { html, text } = digest([item({ sourceUrl })]);
    expect(html).not.toContain("<a ");
    expect(text).toContain("   Link: nie podano\n");
    expect(html).toContain("<br><b>Link:</b> nie podano</p>");
  });

  it("escapes an http(s) link inside the href attribute", () => {
    const { html } = digest([item({ sourceUrl: `https://example.invalid/a?q="><script>'\`` })]);
    const href = /<a href="([^"]*)" style=/.exec(html)?.[1];
    expect(href).toBeDefined();
    expect(href).not.toMatch(/[<>"'`]/);
    expect(html).not.toContain("<script");
  });
});

describe("subject (PR-11)", () => {
  it.each([
    [1, "1 nowe"],
    [2, "2 nowe"],
    [4, "4 nowe"],
    [5, "5 nowych"],
    [11, "11 nowych"],
    [12, "12 nowych"],
    [14, "14 nowych"],
    [21, "21 nowych"],
    [22, "22 nowe"],
    [25, "25 nowych"],
    [100, "100 nowych"],
    [101, "101 nowych"],
    [102, "102 nowe"],
    [112, "112 nowych"],
  ])("counts %i as „%s”", (count, expected) => {
    expect(newCount(count)).toBe(expected);
  });

  it("names the earliest deadline not passed, as a day in Poland", () => {
    const items = [
      item({ deadline: new Date("2026-11-20T10:00:00.000Z") }),
      // 18 November 00:30 in Poland, still 17 November in UTC.
      item({ deadline: new Date("2026-11-17T23:30:00.000Z") }),
      item({ deadline: null }),
      // Passed at NOW: never the "nearest" one.
      item({ deadline: new Date("2026-11-01T05:59:00.000Z") }),
    ];
    expect(digestSubject(items, NOW)).toBe("Radar Zamówień: 4 nowe, najbliższy termin 18.11");
    expect(buildDigest(profile, items, NOW, { overflow: 0 }).subject).toBe(
      "Radar Zamówień: 4 nowe, najbliższy termin 18.11",
    );
  });

  it("leaves the deadline out when no offer has one still open", () => {
    const items = [
      item({ deadline: null }),
      item({ deadline: new Date("2026-10-31T10:00:00.000Z") }),
      item({ deadline: null }),
    ];
    expect(digestSubject(items, NOW)).toBe("Radar Zamówień: 3 nowe");
  });

  it("counts a deadline at the very render time as not passed", () => {
    expect(digestSubject([item({ deadline: NOW })], NOW)).toBe(
      "Radar Zamówień: 1 nowe, najbliższy termin 01.11",
    );
  });
});

describe("snippet", () => {
  it("keeps short text whole", () => {
    expect(snippet("Krótki opis.")).toBe("Krótki opis.");
  });

  it("cuts long text at a word boundary within the limit and marks the cut", () => {
    const words = Array.from({ length: 100 }, (_, index) => `słowo${String(index)}`).join(" ");
    const result = snippet(words);
    expect(Array.from(new Intl.Segmenter().segment(result)).length).toBeLessThanOrEqual(
      SNIPPET_MAX_CHARS,
    );
    expect(result.endsWith("…")).toBe(true);
    expect(words.startsWith(result.slice(0, -1))).toBe(true);
    expect(words.charAt(result.length - 1)).toBe(" ");
  });

  it("cuts a single long word mid-word and never splits a character", () => {
    const result = snippet("ż".repeat(400) + "👍🏽".repeat(10), 10);
    expect(result).toBe(`${"ż".repeat(9)}…`);
    expect(snippet("👍🏽".repeat(20), 5)).toBe(`${"👍🏽".repeat(4)}…`);
  });

  it("collapses whitespace and control characters", () => {
    expect(snippet("a\r\n\tb\u0000c")).toBe("a b c");
  });
});

describe("category labels in the digest (PR-09)", () => {
  it("names every category by its label, never by its key", () => {
    const cleaner: CompanyProfile = {
      ...profile,
      name: "Anna Nowak Sprzątanie",
      categories: ["sprzatanie", "elektryka"],
    };
    // 90910000-9: cleaning services; 45310000-3: electrical installation work.
    const value = offer({ title: "Usługi porządkowe", categories: ["90910000-9", "45310000-3"] });
    const { text, html } = buildDigest(
      cleaner,
      [{ offer: value, reasons: matchOpportunity(value, cleaner).reasons }],
      NOW,
      { overflow: 0 },
    );
    expect(text).toContain(
      "   Dlaczego pasuje: Elektryka · Sprzątanie · słowo „oświetlenie” w opisie · mazowieckie\n",
    );
    expect(html).toContain(
      "<b>Dlaczego pasuje:</b> Elektryka · Sprzątanie · słowo „oświetlenie” w opisie · " +
        "mazowieckie<br>",
    );
    for (const part of [text, html]) {
      expect(part).not.toMatch(/\bsprzatanie\b|\belektryka\b/u);
    }
  });

  it("keeps labels that contain commas apart: middle dots in the sentence, semicolons in the details", () => {
    const service: CompanyProfile = {
      ...profile,
      categories: ["serwis", "instalacje"],
      includeKeywords: [],
    };
    // 50000000-5: repair and maintenance; 45330000-9: plumbing.
    const value = offer({ title: "Konserwacja", categories: ["50000000-5", "45330000-9"] });
    const { text } = buildDigest(
      service,
      [{ offer: value, reasons: matchOpportunity(value, service).reasons }],
      NOW,
      { overflow: 0 },
    );
    // The sentence names the categories only: the codes are in the details.
    expect(text).toContain(
      "   Dlaczego pasuje: Instalacje budowlane (wod.-kan., ogrzewanie, wentylacja) · " +
        "Serwis, naprawy i konserwacja · mazowieckie\n",
    );
    expect(text).toContain("   Szczegóły dopasowania: CPV: 50000000-5, 45330000-9\n");
    // The offer's categories outside the profile: in the details, "; " between names.
    const electrician = buildDigest(
      profile,
      [item({ categories: [...value.categories, "45310000-3"] })],
      NOW,
      {
        overflow: 0,
      },
    );
    expect(electrician.text).toContain(
      "   Szczegóły dopasowania: Inne kategorie ogłoszenia: Instalacje budowlane " +
        "(wod.-kan., ogrzewanie, wentylacja); Serwis, naprawy i konserwacja · " +
        "CPV: 50000000-5, 45330000-9, 45310000-3\n",
    );
  });

  it("counts the codes beyond five after the category names", () => {
    const value = offer({
      categories: [
        "45310000-3",
        "03000000-1",
        "09000000-3",
        "14000000-1",
        "15000000-8",
        "16000000-5",
        "18000000-9",
      ],
    });
    const { text } = digest([{ offer: value, reasons: matchOpportunity(value, profile).reasons }]);
    expect(text).toContain(
      "   Szczegóły dopasowania: CPV: 45310000-3, 03000000-1, 09000000-3, 14000000-1, " +
        "15000000-8 i 2 inne\n",
    );
    expect(text).toContain("   Dlaczego pasuje: Elektryka · ");
  });
});

describe("web links in the digest (PR-06A)", () => {
  const token = "T".repeat(43);
  const links = {
    profileUrl: `https://radar.example.invalid/dostep/${token}`,
    unsubscribeUrl: `https://radar.example.invalid/wypis/${"U".repeat(43)}`,
  };

  it("adds the profile link and the one-click unsubscribe link to both parts", () => {
    const { text, html } = buildDigest(profile, [item()], NOW, { overflow: 0, links });
    expect(text).toContain(`Twój profil (link jednorazowy, ważny 7 dni;`);
    expect(text).toContain(`dostęp do profilu): ${links.profileUrl}\n`);
    expect(text).toContain(
      `Aby zrezygnować z powiadomień, otwórz ten link (albo odpowiedz na tę wiadomość): ${links.unsubscribeUrl}\n`,
    );
    // HTML: short link texts (PR-06B); the text part keeps the URLs (above).
    expect(html).toContain(`<a href="${links.profileUrl}">Otwórz swój profil</a>`);
    expect(html).toContain(`<a href="${links.unsubscribeUrl}">Wypisz się z powiadomień</a>`);
    expect(html).not.toContain(`>${links.profileUrl}<`);
    expect(html).not.toContain(`>${links.unsubscribeUrl}<`);
    expect(text).not.toContain("napisz do operatora");
  });

  it("says what the profile page offers, next to its link (PR-09)", () => {
    const { text, html } = buildDigest(profile, [item()], NOW, { overflow: 0, links });
    for (const part of [text, html]) {
      expect(part).toContain(
        "Na stronie profilu możesz zmienić kategorie, regiony i słowa kluczowe oraz " +
          "zobaczyć wszystkie pasujące zamówienia.",
      );
    }
    const without = buildDigest(profile, [item()], NOW, { overflow: 0 });
    expect(without.text).not.toContain("Na stronie profilu");
  });

  it("keeps the reply-only footer without links", () => {
    const { text, html } = buildDigest(profile, [item()], NOW, { overflow: 0 });
    for (const part of [text, html]) {
      expect(part).not.toContain("Twój profil");
      expect(part).not.toContain("/wypis/");
      expect(part).toContain("odpowiedz na tę wiadomość lub napisz do operatora serwisu");
    }
  });

  it("shows no link that is not http(s), and escapes the ones it shows", () => {
    const odd = buildDigest(profile, [item()], NOW, {
      overflow: 0,
      links: { profileUrl: "javascript:alert(1)", unsubscribeUrl: 'https://a.invalid/w?x="<' },
    });
    expect(odd.text).not.toContain("javascript:");
    expect(odd.text).not.toContain("Twój profil");
    expect(odd.html).toContain('<a href="https://a.invalid/w?x=%22%3C">');
  });
});

describe("matchingItems (shared by the digest and /dopasowania)", () => {
  // Some match, some are in another region, some lack the keyword.
  const offers = Array.from({ length: 405 }, (_, index) =>
    offer(
      index % 3 === 1
        ? { location: { voivodeship: "opolskie" } }
        : index % 3 === 2
          ? { title: `Dostawa papieru ${String(index)}`, description: null }
          : {},
    ),
  );

  it("returns the matching offers in order, with their reasons, as matching each does", async () => {
    const expected = offers.flatMap((value) => {
      const result = matchOpportunity(value, profile);
      return result.matched ? [{ offer: value, reasons: result.reasons }] : [];
    });
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(offers.length);
    expect(await matchingItems(profile, offers)).toEqual(expected);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Matches `offers` with a clock advancing `stepMs` per reading; counts event-loop turns. */
  async function turnsWhileMatching(stepMs: number) {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += stepMs));
    let turns = 0;
    let stopped = false;
    const countTurn = (): void => {
      turns += 1;
      if (!stopped) onNextLoop(countTurn);
    };
    onNextLoop(countTurn);
    const items = await matchingItems(profile, offers);
    stopped = true;
    return { turns, items };
  }

  it(`lets the event loop run once ${String(MATCH_YIELD_AFTER_MS)} ms of matching have passed`, async () => {
    const expected = await matchingItems(profile, offers);
    // Slow matching (each offer "takes" the whole budget): yields all along the list.
    const slow = await turnsWhileMatching(MATCH_YIELD_AFTER_MS);
    expect(slow.turns).toBeGreaterThanOrEqual(offers.length / 4);
    expect(slow.items).toEqual(expected);
    // Fast matching (the budget is never spent): the list is matched without yielding.
    vi.restoreAllMocks();
    const fast = await turnsWhileMatching(0);
    expect(fast.turns).toBe(0);
    expect(fast.items).toEqual(expected);
  });
});

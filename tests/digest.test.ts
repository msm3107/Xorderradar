import { describe, expect, it } from "vitest";
import type { CompanyProfile } from "../src/domain/company-profile.js";
import type { Opportunity } from "../src/domain/opportunity.js";
import { matchOpportunity } from "../src/matching/match.js";
import {
  buildDigest,
  escapeHtml,
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
    expect(subject).toBe("Radar Zamówień: 1 nowe zamówienie — Jan Kowalski Elektryka");
    const lines = [
      "Znaleźliśmy dziś 1 nowe zamówienie pasujące do Twojej firmy.",
      "1. Modernizacja oświetlenia w szkole",
      "   Zamawiający: Gmina Przykładowa",
      "   Lokalizacja: Przykładowo, woj. mazowieckie",
      "   Termin składania ofert: 2026-11-05 12:00 (czas polski)",
      "   Data publikacji: 2026-10-30",
      "   Kategoria: elektryka (CPV 45310000-3)",
      "   Opis: Wymiana opraw oświetleniowych na LED.",
      "   Kontakt: Jan Kowalski, kontakt@example.invalid, 000 000 000",
      "   Dlaczego pasuje: kategoria: elektryka (CPV 45310000-3); słowo: oświetlenie (tytuł); region: mazowieckie",
      `   Link: ${one.offer.sourceUrl}`,
    ];
    for (const line of lines) expect(text.split("\n")).toContain(line);
    // The same content in the HTML part.
    for (const line of lines.slice(1)) {
      const value = line.replace(/^ *(?:\d+\. |[^:]+: )/u, "");
      expect(html).toContain(escapeHtml(value));
    }
    expect(html).toContain(`<a href="${one.offer.sourceUrl}">`);
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
    expect(text).toContain("   Lokalizacja: nie podano\n");
    expect(text).toContain("   Termin składania ofert: nie podano\n");
    expect(text).toContain("   Data publikacji: nie podano\n");
    expect(text).toContain("   Kategoria: nie podano\n");
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
      "   Kategoria: CPV 03000000-1, 09000000-3, 14000000-1, 15000000-8, 16000000-5 i 1 inny\n",
    );
  });

  it("sorts by deadline, soonest first, unknown last", () => {
    const later = item({ title: "Później", deadline: new Date("2026-11-20T10:00:00.000Z") });
    const none = item({ title: "Bez terminu", deadline: null });
    const sooner = item({ title: "Wcześniej", deadline: new Date("2026-11-03T10:00:00.000Z") });
    const { text } = digest([later, none, sooner]);
    expect(text.match(/^\d+\. .*$/gmu)).toEqual(["1. Wcześniej", "2. Później", "3. Bez terminu"]);
  });

  it.each([
    [2, "2 nowe zamówienia pasujące", "2 nowe zamówienia"],
    [5, "5 nowych zamówień pasujących", "5 nowych zamówień"],
    [12, "12 nowych zamówień pasujących", "12 nowych zamówień"],
    [22, "22 nowe zamówienia pasujące", "22 nowe zamówienia"],
  ])("uses the Polish plural for %i offers", (count, heading, subject) => {
    const { text, subject: actual } = digest(Array.from({ length: count }, () => item()));
    expect(text.startsWith(`Znaleźliśmy dziś ${heading} do Twojej firmy.\n`)).toBe(true);
    expect(actual).toBe(`Radar Zamówień: ${subject} — Jan Kowalski Elektryka`);
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
        `</strong></p>\n<p>${escapeHtml(notice)}</p>\n<ol`,
    );
  });

  it("says nothing about overflow when everything fitted", () => {
    const { text, html } = digest([item()], 0);
    expect(text).not.toContain("wyślemy w następnych dniach");
    expect(html).not.toContain("wyślemy w następnych dniach");
  });

  it("keeps source text out of the subject and line breaks out of the profile name", () => {
    const hostileProfile = { name: "Firma\r\nBcc: x@example.invalid" };
    const { subject } = buildDigest(hostileProfile, [item({ title: "Tytuł ze źródła" })], NOW, {
      overflow: 0,
    });
    expect(subject).toBe("Radar Zamówień: 1 nowe zamówienie — Firma Bcc: x@example.invalid");
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).not.toContain("Tytuł ze źródła");
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
    expect(html).toContain("<li><strong>Link:</strong> nie podano</li>");
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
    expect(html).toContain("<li><strong>Link:</strong> nie podano</li>");
  });

  it("escapes an http(s) link inside the href attribute", () => {
    const { html } = digest([item({ sourceUrl: `https://example.invalid/a?q="><script>'\`` })]);
    const href = /<a href="([^"]*)">/.exec(html)?.[1];
    expect(href).toBeDefined();
    expect(href).not.toMatch(/[<>"'`]/);
    expect(html).not.toContain("<script");
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
    expect(html).toContain(`<a href="${links.profileUrl}">${links.profileUrl}</a>`);
    expect(html).toContain(`<a href="${links.unsubscribeUrl}">${links.unsubscribeUrl}</a>`);
    expect(text).not.toContain("napisz do operatora");
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

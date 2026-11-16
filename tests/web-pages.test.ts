import { describe, expect, it } from "vitest";
import type { CompanyProfile } from "../src/domain/company-profile.js";
import type { Opportunity } from "../src/domain/opportunity.js";
import { MVP_CATEGORIES, VOIVODESHIPS } from "../src/domain/vocabulary.js";
import { matchOpportunity } from "../src/matching/match.js";
import { MORE_LABEL, offerCard } from "../src/notifications/card.js";
import {
  errorPage,
  feedbackConfirmPage,
  feedbackSavedPage,
  invalidLinkPage,
  loginConfirmPage,
  loginRefusedPage,
  matchesBusyPage,
  matchesPage,
  matchesTooManyPage,
  matchesUnavailablePage,
  profilePage,
  profileSaveBlockedPage,
  settingsPage,
  unsubscribeConfirmPage,
  type MatchesView,
  STYLESHEET,
} from "../src/web/pages.js";
import { REGION_ALL, REGION_SELECTED, type ProfileFormValues } from "../src/web/profile-form.js";

/*
 * PR-06B: the customer pages as pure functions — the profile form's
 * accessible markup, the matches page, notices and the copy fixes. The
 * server-level flows are in tests/integration/web-profile.test.ts.
 * Pseudonymised data only.
 */

const NO_SCRIPT = /<script|\sstyle=|<style|\son[a-z]+=|javascript:/i;
/** For pages showing hostile text: escaped, it may still read `onerror=` as text. */
const NO_MARKUP_FROM_DATA = /<script|<img|<b>|javascript:/i;

const values: ProfileFormValues = {
  name: "Jan Kowalski",
  email: "kontakt@example.invalid",
  categories: ["elektryka", "it"],
  region: REGION_SELECTED,
  voivodeships: ["mazowieckie"],
  includeKeywords: "oświetlenie\nlatarnie",
  excludeKeywords: "",
};

/** The opening tag of the element with `id`. */
function tagWithId(html: string, id: string): string {
  const match = new RegExp(`<[a-z]+ [^>]*id="${id}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`no element with id ${id}`);
  return match[0];
}

describe("settingsPage", () => {
  it("labels every control and groups the checkboxes in fieldsets with legends", () => {
    const page = settingsPage(values, "csrf-token");
    expect(page.status).toBe(200);
    const { html } = page;
    expect(html).toContain("<title>Ustawienia profilu — Radar Zamówień</title>");
    expect(html).toContain('<form method="post" action="/profil/ustawienia">');
    expect(html).toContain('<input type="hidden" name="csrf" value="csrf-token">');
    expect(html).toContain('<button type="submit" class="primary">Zapisz</button>');
    expect(html).not.toMatch(NO_SCRIPT);
    expect(html).not.toContain("error-summary");
    expect(html).not.toContain("aria-invalid");

    // Every control has an id with exactly one <label for=…>.
    const ids = [
      ...html.matchAll(/<(?:input|textarea) (?:type="(?!hidden)[a-z]+" )?[^>]*id="([^"]+)"/g),
    ]
      .map((match) => match[1] ?? "")
      .filter((id) => id !== "");
    // name, e-mail, 2 keyword lists, the 2 region radios (PR-13: no counties field).
    expect(ids).toHaveLength(4 + 2 + MVP_CATEGORIES.length + VOIVODESHIPS.length);
    for (const id of ids) {
      expect(html.match(new RegExp(`<label for="${id}">`, "g"))).toHaveLength(1);
    }
    // PR-13: the one-field e-mail fieldset is gone; the address keeps its label.
    expect(html.match(/<fieldset/g)).toHaveLength(2);
    for (const legend of ["Kategorie", "Województwa"]) {
      expect(html).toContain(`<legend>${legend}</legend>`);
    }
    expect(html).toContain('<label for="email">Adres e-mail</label>');
    expect(html).toContain(
      '<label for="kategoria-4">IT (usługi, oprogramowanie, sprzęt komputerowy)</label>',
    );
    // Hints are tied to their controls.
    expect(tagWithId(html, "nazwa")).toContain('aria-describedby="nazwa-opis"');
    expect(tagWithId(html, "slowa")).toContain('aria-describedby="slowa-opis"');
    expect(html).toContain('<p class="hint" id="nazwa-opis">');
    expect(html).toContain('<fieldset aria-describedby="kategoria-opis">');
  });

  it("shows the stored values: checked boxes and one entry per line", () => {
    const { html } = settingsPage(values, "c");
    expect(html).toContain('name="name" value="Jan Kowalski"');
    expect(html).toContain('name="email" value="kontakt@example.invalid"');
    expect(html.match(/ checked>/g)).toHaveLength(3);
    expect(html).toContain('value="elektryka" checked>');
    expect(html).toContain('value="it" checked>');
    expect(html).toContain('value="mazowieckie" checked>');
    expect(html).toContain('value="opolskie">');
    expect(tagWithId(html, "region-wybrane")).toContain('value="selected" checked required>');
    expect(tagWithId(html, "region-polska")).toContain('value="all" required>');
    // The parser drops the newline right after <textarea>: the value is intact.
    expect(html).toContain('aria-describedby="slowa-opis">\noświetlenie\nlatarnie</textarea>');
  });

  it("re-renders an invalid form as 400 with an error summary linking to the fields", () => {
    const page = settingsPage(values, "c", {
      name: ["Podaj nazwę firmy."],
      email: ["Podaj poprawny adres e-mail, na przykład nazwa@firma.pl."],
      categories: ["Wybierz co najmniej jedną kategorię."],
      includeKeywords: ["Wiersz 1: a", "Wiersz 2: b"],
    });
    expect(page.status).toBe(400);
    const { html } = page;
    expect(html).toContain("<title>Błąd: Ustawienia profilu — Radar Zamówień</title>");
    expect(html).toContain(
      '<div class="error-summary" role="alert" aria-labelledby="bledy-tytul">',
    );
    const summary = html.slice(html.indexOf("error-summary"), html.indexOf("</div>"));
    expect(
      [...summary.matchAll(/<li><a href="#([^"]+)">([^<]+)<\/a><\/li>/g)].map((m) => [m[1], m[2]]),
    ).toEqual([
      ["nazwa", "Nazwa firmy: Podaj nazwę firmy."],
      ["email", "Adres e-mail: Podaj poprawny adres e-mail, na przykład nazwa@firma.pl."],
      ["kategoria-1", "Kategorie: Wybierz co najmniej jedną kategorię."],
      ["slowa", "Słowa kluczowe: Wiersz 1: a"],
      ["slowa", "Słowa kluczowe: Wiersz 2: b"],
    ]);
    expect(tagWithId(html, "nazwa")).toContain(
      'aria-describedby="nazwa-opis nazwa-blad" aria-invalid="true"',
    );
    expect(tagWithId(html, "email")).toContain(
      'aria-describedby="email-opis email-blad" aria-invalid="true"',
    );
    expect(tagWithId(html, "slowa")).toContain('aria-invalid="true"');
    expect(html).not.toContain('id="powiaty"');
    expect(tagWithId(html, "region-polska")).not.toContain("aria-invalid");
    expect(tagWithId(html, "wykluczenia")).not.toContain("aria-invalid");
    expect(html).toContain(
      '<p class="error" id="slowa-blad"><span>Błąd: Wiersz 1: a</span><br><span>Błąd: Wiersz 2: b</span></p>',
    );
    expect(html).toContain('<fieldset aria-describedby="kategoria-opis kategoria-blad">');
    expect(tagWithId(html, "kategoria-1")).toContain('aria-invalid="true"');
    expect(tagWithId(html, "wojewodztwo-1")).not.toContain("aria-invalid");
  });

  it("escapes every submitted value and never echoes an unknown checkbox value", () => {
    const hostile = `"><script>alert(1)</script>&'`;
    const { html } = settingsPage(
      {
        name: hostile,
        email: hostile,
        categories: [hostile],
        region: hostile,
        voivodeships: [hostile],
        includeKeywords: `</textarea>${hostile}`,
        excludeKeywords: hostile,
      },
      hostile,
      { name: [hostile] },
    );
    expect(html).not.toMatch(NO_SCRIPT);
    // Only the two real closing tags (PR-13: no counties textarea): the value cannot end its textarea.
    expect(html.match(/<\/textarea>/g)).toHaveLength(2);
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;");
    expect(html).toContain("&lt;/textarea&gt;");
    expect(html).not.toContain(" checked");
  });
});

describe("matchesPage", () => {
  const offer: Opportunity = {
    id: "00000000-0000-4000-8000-000000000001",
    sourceId: "bzp",
    sourceUrl: "https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1",
    externalId: "2026/BZP 1",
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: "Modernizacja oświetlenia",
    description: null,
    location: { city: "Przykładowo", voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-10-30T08:00:00.000Z"),
    deadline: new Date("2026-11-05T11:00:00.000Z"),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: null,
    fetchedAt: new Date("2026-10-30T09:00:00.000Z"),
    fingerprint: "fp-1",
    contentHash: "hash-1",
    status: "open",
    firstSeenAt: new Date("2026-10-30T09:00:00.000Z"),
    updatedAt: new Date("2026-10-30T09:00:00.000Z"),
  };
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
  const reasons = matchOpportunity(offer, profile).reasons;
  /** The render time: the deadline (5 November 12:00 in Poland) is 4 days away. */
  const NOW = new Date("2026-11-01T06:00:00.000Z");
  const cardOf = (value: Opportunity) => offerCard({ offer: value, reasons }, NOW);

  function view(overrides: Partial<MatchesView> = {}): MatchesView {
    return {
      active: true,
      hasVoivodeships: true,
      hasCounties: false,
      stateAt: "2026-11-02 07:00",
      windowDays: 7,
      items: [cardOf(offer)],
      pagination: { page: 1, pages: 1, offset: 0, listed: 1, limit: 1000 },
      more: 0,
      truncated: false,
      ...overrides,
    };
  }

  it("shows each offer's title, value, deadline, buyer, location, publication date, reasons and source", () => {
    const page = matchesPage(view());
    expect(page.status).toBe(200);
    const { html } = page;
    expect(html).not.toMatch(NO_SCRIPT);
    expect(html).toContain('<ol class="matches"><li><article><h2>Modernizacja oświetlenia</h2>');
    for (const field of [
      "<dt>Wartość szacunkowa:</dt><dd>nie podano</dd>",
      "<dt>Termin składania ofert:</dt><dd>05.11.2026 (czw) 12:00 — za 4 dni</dd>",
      "<dt>Zamawiający:</dt><dd>Gmina Przykładowa</dd>",
      "<dt>Lokalizacja:</dt><dd>Przykładowo, woj. mazowieckie</dd>",
      "<dt>Data publikacji:</dt><dd>30.10.2026</dd>",
      "<dt>Dlaczego pasuje:</dt><dd>Elektryka · słowo „oświetlenie” w tytule · mazowieckie</dd>",
    ]) {
      expect(html).toContain(field);
    }
    expect(html).toContain(
      '<p><a class="button" href="https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1" ' +
        'rel="noopener noreferrer">Otwórz ogłoszenie</a></p>',
    );
    expect(html).toContain("ostatnich 7 dni");
    expect(html).toContain("Stan na 2026-11-02 07:00 (czas polski).");
    expect(html).not.toContain('class="note"');
    expect(html).toContain('<a href="/profil">Twój profil</a>');
  });

  it("shows value, deadline and why, the button, the rest, then one disclosure with the details", () => {
    const full: Opportunity = {
      ...offer,
      estimatedValue: "120000.00",
      currency: "PLN",
      description: "Wymiana opraw <LED> & słupów",
      contact: { email: "zamowienia@example.invalid", phone: "000 000 000" },
    };
    const { html } = matchesPage(view({ items: [cardOf(full)] }));
    expect(html).not.toMatch(NO_SCRIPT);
    const card = /<li><article>(.*?)<\/article><\/li>/s.exec(html)?.[1] ?? "";
    expect(card).toBe(
      "<h2>Modernizacja oświetlenia</h2><dl>" +
        "<dt>Wartość szacunkowa:</dt><dd>120\u00a0000,00 PLN (źródło nie podaje, netto czy brutto)</dd>" +
        "<dt>Termin składania ofert:</dt><dd>05.11.2026 (czw) 12:00 — za 4 dni</dd>" +
        "<dt>Dlaczego pasuje:</dt><dd>Elektryka · słowo „oświetlenie” w tytule · mazowieckie</dd></dl>" +
        '<p><a class="button" href="https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1" ' +
        'rel="noopener noreferrer">Otwórz ogłoszenie</a></p><dl>' +
        "<dt>Zamawiający:</dt><dd>Gmina Przykładowa</dd>" +
        "<dt>Lokalizacja:</dt><dd>Przykładowo, woj. mazowieckie</dd>" +
        "<dt>Opis:</dt><dd>Wymiana opraw &lt;LED&gt; &amp; słupów</dd></dl>" +
        "<details><summary>Więcej szczegółów (data publikacji, kontakt, szczegóły dopasowania)</summary><dl>" +
        "<dt>Data publikacji:</dt><dd>30.10.2026</dd>" +
        "<dt>Kontakt:</dt><dd>zamowienia@example.invalid, 000 000 000</dd>" +
        "<dt>Szczegóły dopasowania:</dt><dd><ul><li>CPV: 45310000-3</li></ul></dd></dl></details>",
    );
    // One disclosure for the details, never one inside another.
    expect(card.match(/<details>/g)).toHaveLength(1);
  });

  it("names only what the disclosure holds in its summary", () => {
    const { html } = matchesPage(view());
    expect(html).toContain(
      "<details><summary>Więcej szczegółów (data publikacji, szczegóły dopasowania)</summary><dl>" +
        "<dt>Data publikacji:</dt><dd>30.10.2026</dd>",
    );
  });

  it("marks an urgent deadline with the visible word PILNE", () => {
    const tomorrow: Opportunity = { ...offer, deadline: new Date("2026-11-02T09:00:00.000Z") };
    const { html } = matchesPage(view({ items: [cardOf(tomorrow)] }));
    expect(html).toContain(
      '<dt>Termin składania ofert:</dt><dd><strong class="pilne">PILNE</strong> ' +
        "02.11.2026 (pn) 10:00 — jutro</dd>",
    );
    expect(matchesPage(view()).html).not.toContain("PILNE");
  });

  it("shows a long description's excerpt and the whole text inside <details>", () => {
    const words = Array.from({ length: 80 }, (_, index) => `słowo${String(index)}`).join(" ");
    const long: Opportunity = { ...offer, description: `${words} <b>` };
    const { html } = matchesPage(view({ items: [cardOf(long)] }));
    expect(html).not.toMatch(NO_SCRIPT);
    const opis = /<dt>Opis:<\/dt><dd>(.*?)<\/dd>/s.exec(html)?.[1] ?? "";
    const [excerpt = "", folded = ""] = opis.split("<details>");
    expect(excerpt.endsWith("…")).toBe(true);
    expect(words.startsWith(excerpt.slice(0, -1))).toBe(true);
    expect(folded).toBe(`<summary>Pełny opis</summary><p>${words} &lt;b&gt;</p></details>`);
    // A short one has nothing to unfold.
    expect(matchesPage(view()).html).not.toContain("Pełny opis");
  });

  it("puts the technical reasons in the match details, not in the sentence", () => {
    const unknownRegion: Opportunity = { ...offer, location: { city: "Wzorowo" } };
    const value = { ...unknownRegion };
    const { html } = matchesPage(
      view({
        items: [
          offerCard({ offer: value, reasons: matchOpportunity(value, profile).reasons }, NOW),
        ],
      }),
    );
    expect(html).toContain(
      "<dt>Dlaczego pasuje:</dt><dd>Elektryka · słowo „oświetlenie” w tytule</dd>",
    );
    expect(html).toContain(
      "<dt>Szczegóły dopasowania:</dt><dd><ul><li>CPV: 45310000-3</li>" +
        "<li>region: nieznany — źródło nie podaje województwa</li></ul></dd></dl></details>",
    );
  });

  it("shows a Baza Konkurencyjności offer's attribution in the visible part, after the link", () => {
    const bk: Opportunity = {
      ...offer,
      sourceId: "bk",
      sourceUrl: "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296920",
      externalId: "296920",
    };
    const { html } = matchesPage(view({ items: [cardOf(bk)] }));
    const [visible = "", folded = ""] = html.split("<details>");
    expect(visible).toContain(
      '<p><a class="button" href="https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296920" ' +
        'rel="noopener noreferrer">Otwórz ogłoszenie</a></p><dl>' +
        "<dt>Zamawiający:</dt><dd>Gmina Przykładowa</dd>" +
        "<dt>Lokalizacja:</dt><dd>Przykładowo, woj. mazowieckie</dd>" +
        "<dt>Źródło:</dt><dd>Baza Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej; " +
        "pobrano 2026-10-30; dane przetworzone: skrócone i ujednolicone</dd></dl>",
    );
    expect(folded).not.toContain("Źródło");
    // A BZP card has none.
    expect(matchesPage(view()).html).not.toContain("<dt>Źródło:</dt>");
  });

  it("leaves a missing description and contact out of the card, as before", () => {
    const { html } = matchesPage(view());
    expect(html).toContain("<dt>Data publikacji:</dt>");
    expect(html).not.toContain("<dt>Opis:</dt>");
    expect(html).not.toContain("<dt>Kontakt:</dt>");
  });

  it("shows a missing location as not given, in the visible part", () => {
    const nowhere: Opportunity = { ...offer, location: null };
    const { html } = matchesPage(view({ items: [cardOf(nowhere)] }));
    const [visible = "", folded = ""] = html.split("<details>");
    expect(visible).toContain(
      "<dt>Zamawiający:</dt><dd>Gmina Przykładowa</dd><dt>Lokalizacja:</dt><dd>nie podano</dd>",
    );
    expect(folded).not.toContain("Lokalizacja");
  });

  it("escapes a hostile title and never links a non-http(s) URL", () => {
    const hostile = {
      ...offer,
      title: `<img src=x onerror="alert(1)">"&'`,
      issuerName: "<b>Gmina</b>",
      sourceUrl: "javascript:alert(1)",
    };
    const { html } = matchesPage(view({ items: [cardOf(hostile)] }));
    expect(html).not.toMatch(NO_MARKUP_FROM_DATA);
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "<h2>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&quot;&amp;&#39;</h2>",
    );
    expect(html).toContain("<dd>&lt;b&gt;Gmina&lt;/b&gt;</dd>");
    expect(html).toContain("<dt>Link:</dt><dd>nie podano</dd></dl>");
    // Where the button would be: right after "Dlaczego pasuje", before the buyer.
    expect(html).toContain("</dd><dt>Link:</dt><dd>nie podano</dd></dl><dl><dt>Zamawiający:</dt>");
    expect(html).not.toContain('class="button"');

    const quoted = { ...offer, sourceUrl: 'https://example.invalid/a?b="><script>' };
    const quotedHtml = matchesPage(view({ items: [cardOf(quoted)] })).html;
    expect(quotedHtml).not.toMatch(NO_MARKUP_FROM_DATA);
    // The URL parser percent-encodes the quote and brackets; escaping is the second line.
    expect(quotedHtml).toContain('href="https://example.invalid/a?b=%22%3E%3Cscript%3E"');
  });

  it("explains the window when nothing matches", () => {
    const { html } = matchesPage(view({ items: [] }));
    expect(html).toContain(
      "Brak pasujących zamówień. Pokazujemy zamówienia dodane do Radaru w ciągu ostatnich 7 dni, " +
        "których termin składania ofert jeszcze nie minął.",
    );
    expect(html).toContain('<a href="/profil/ustawienia">ustawieniach</a>');
    expect(html).not.toContain("<ol");
  });

  it("advises widening the profile truthfully, with or without voivodeships", () => {
    const withRegions = matchesPage(view({ items: [] })).html;
    // PR-13: the whole country is the „Cała Polska” radio, not unticking every box.
    expect(withRegions).toContain(
      "dodaj kategorie, słowa kluczowe lub województwa (albo wybierz „Cała Polska”) albo usuń " +
        "część słów wykluczających.",
    );
    // None ticked already means the whole country: no advice to add voivodeships.
    const wholeCountry = matchesPage(view({ items: [], hasVoivodeships: false })).html;
    expect(wholeCountry).toContain(
      ": dodaj kategorie lub słowa kluczowe albo usuń część słów wykluczających.",
    );
    expect(wholeCountry).not.toContain("województwa (");
    expect(withRegions).not.toContain("powiat");
    const counties = matchesPage(view({ items: [], hasCounties: true })).html;
    // PR-13: counties are the operator's; no note asks the customer to edit them.
    expect(counties).toContain(
      "<p>Powiaty zapisane w profilu nie zawężają listy: ogłoszenia nie podają jeszcze " +
        "powiatu, więc liczy się województwo.</p>",
    );
    const countiesOnly = matchesPage(
      view({ items: [], hasCounties: true, hasVoivodeships: false }),
    ).html;
    expect(countiesOnly).toContain(
      "<p>Profil ma zapisane powiaty, a ogłoszenia nie podają jeszcze powiatu: bez " +
        "zaznaczonego województwa pokazujemy tylko zamówienia pasujące jednocześnie kategorią " +
        "i słowem kluczowym. Wybierz w ustawieniach „Wybrane województwa” i zaznacz " +
        "województwo.</p>",
    );
    expect(countiesOnly).not.toContain("nie zawężają listy");
    expect(counties).not.toContain("Profil ma zapisane powiaty");
    for (const html of [counties, countiesOnly]) {
      expect(html).not.toMatch(/(wpisz|wpisane|wpisan[ey]|dopisz|zmień)[^.]*powiat/i);
    }
  });

  it("says the list includes offers already sent by e-mail", () => {
    expect(matchesPage(view()).html).toContain(
      " (czas polski). Lista obejmuje także zamówienia, które już wysłaliśmy e-mailem.</p>",
    );
  });

  it("notes an inactive profile, the overflow and a truncated candidate list", () => {
    const { html } = matchesPage(view({ active: false, more: 3, truncated: true }));
    expect(html).toContain(
      '<p class="note">Powiadomienia e-mail są wyłączone: tej listy nie wysyłamy.',
    );
    // PR-13: the overflow is what is beyond the page limit, on no page.
    expect(html).toContain(
      "<p>Lista kończy się na 1000 zamówieniach. Nie pokazujemy 3 kolejnych pasujących " +
        "zamówień z dalszym terminem lub ocenionych jako nietrafne. Aby lista była krótsza, " +
        "zawęź profil, np. słowami wykluczającymi.</p>",
    );
    expect(html).toContain("Lista może być niepełna");
    expect(matchesPage(view({ more: 1 })).html).toContain(
      "Nie pokazujemy 1 kolejnego pasującego zamówienia z dalszym terminem lub ocenionego " +
        "jako nietrafne.",
    );
    expect(matchesPage(view({ more: 12 })).html).toContain(
      "Nie pokazujemy 12 kolejnych pasujących zamówień z dalszym terminem lub ocenionych " +
        "jako nietrafne.",
    );
    expect(matchesPage(view()).html).not.toContain("z dalszym terminem");
  });

  it("asks to correct a stored profile it cannot match", () => {
    const { html } = matchesUnavailablePage();
    expect(html).toContain('<a href="/profil/ustawienia">ustawieniach profilu</a>');
  });

  // PR-13: counties are not on the form; their correction is the operator's.
  it("sends to support, not to the form, when only the operator can correct the profile", () => {
    for (const contact of [null, "pomoc@example.invalid"]) {
      const page = matchesUnavailablePage(false, contact);
      expect(page.status).toBe(200);
      expect(page.html).toContain(
        "<p>Profil zawiera ustawienie, które może poprawić tylko obsługa serwisu (na przykład " +
          "powiaty).</p>",
      );
      expect(page.html).not.toContain("Popraw go w");
      expect(page.html).not.toContain('href="/profil/ustawienia"');
      expect(page.html).toContain(
        contact === null
          ? "<p>Odpowiedz na ostatnią wiadomość od nas — obsługa serwisu poprawi profil.</p>"
          : '<p>Napisz do obsługi serwisu: <a href="mailto:pomoc@example.invalid">' +
              "pomoc@example.invalid</a>.</p>",
      );
    }
    // The correctable case keeps its link to the form, with or without a contact.
    expect(matchesUnavailablePage(true, "pomoc@example.invalid").html).toContain(
      '<a href="/profil/ustawienia">ustawieniach profilu</a>',
    );
  });

  it("refuses a save blocked by an operator setting with 409 and support's contact", () => {
    for (const contact of [null, "pomoc@example.invalid"]) {
      const page = profileSaveBlockedPage(contact);
      expect(page.status).toBe(409);
      expect(page.html).toContain("<title>Nie zapisano zmian");
      expect(page.html).toContain(
        "<h1>Nie zapisano zmian</h1>\n<p>Profil zawiera ustawienie, które może poprawić tylko " +
          "obsługa serwisu (na przykład powiaty). Dopóki go nie poprawi, zmian w formularzu nie " +
          "da się zapisać.</p>",
      );
      expect(page.html).toContain(
        contact === null
          ? "Odpowiedz na ostatnią wiadomość od nas"
          : 'href="mailto:pomoc@example.invalid"',
      );
      expect(page.html).toContain('<a href="/profil">Twój profil</a>');
    }
    // A hostile contact is escaped.
    expect(profileSaveBlockedPage('a"b@example.invalid').html).toContain(
      'href="mailto:a&quot;b@example.invalid"',
    );
  });

  // PR-13: a waiting page that reloads itself (meta refresh, no script) to the same URL.
  it("reloads the same page by itself while another list is being computed (503)", () => {
    const page = matchesBusyPage("/dopasowania");
    expect(page.status).toBe(503);
    expect(page.html).toContain(
      '<meta http-equiv="refresh" content="3; url=/dopasowania">\n</head>',
    );
    expect(page.html).toContain("<p>Liczymy listę… strona odświeży się sama za kilka sekund.</p>");
    expect(page.html).toContain('<p><a href="/dopasowania">Odśwież teraz</a></p>');
    expect(page.html).toContain('<a href="/profil">Twój profil</a>');
    expect(page.html).not.toMatch(NO_SCRIPT);
    const second = matchesBusyPage("/dopasowania.csv?strona=2").html;
    expect(second).toContain(
      '<meta http-equiv="refresh" content="3; url=/dopasowania.csv?strona=2">',
    );
    expect(second).toContain('<a href="/dopasowania.csv?strona=2">Odśwież teraz</a>');
    // Escaped, should a URL ever carry markup (the server builds it from a number).
    const hostile = matchesBusyPage('/dopasowania?x="><script>').html;
    expect(hostile).toContain('url=/dopasowania?x=&quot;&gt;&lt;script&gt;">');
    expect(hostile).not.toMatch(NO_SCRIPT);
    // The CSV waits for a file, not a page: download words, the same refresh.
    const csv = matchesBusyPage("/dopasowania.csv?strona=2", "csv").html;
    expect(csv).toContain('<meta http-equiv="refresh" content="3; url=/dopasowania.csv?strona=2">');
    expect(csv).toContain("<p>Przygotowujemy plik… pobierze się sam za kilka sekund.</p>");
    expect(csv).toContain('<p><a href="/dopasowania.csv?strona=2">Pobierz teraz</a></p>');
    expect(csv).not.toContain("Odśwież teraz");
    expect(csv).not.toContain("strona odświeży się");
    expect(csv).not.toMatch(NO_SCRIPT);
    // PR-14: the whole list's CSV reloads the whole list's CSV.
    const whole = matchesBusyPage("/dopasowania.csv", "csv").html;
    expect(whole).toContain('<meta http-equiv="refresh" content="3; url=/dopasowania.csv">');
    expect(whole).toContain('<p><a href="/dopasowania.csv">Pobierz teraz</a></p>');
    // Every other page has no refresh.
    expect(matchesPage(view()).html).not.toContain("http-equiv");
    expect(matchesTooManyPage("/dopasowania").html).not.toContain("http-equiv");
  });

  it("explains the per-session limit (429) in plain words, with the way back", () => {
    const page = matchesTooManyPage("/dopasowania?strona=3");
    expect(page.status).toBe(429);
    expect(page.html).toContain(
      "<p>Ta lista już się przygotowuje (np. w innej karcie albo po odświeżeniu). Poczekaj " +
        "chwilę i otwórz ją ponownie.</p>",
    );
    expect(page.html).toContain('<p><a href="/dopasowania?strona=3">Otwórz listę ponownie</a></p>');
    expect(page.html).toContain('<a href="/profil">Twój profil</a>');
    expect(page.html).not.toMatch(/sesj|slot|żądań|429|limit/i);
    expect(page.html).not.toMatch(NO_SCRIPT);
  });

  describe("pages (PR-13)", () => {
    const many = (count: number) => Array.from({ length: count }, () => cardOf(offer));
    const second = view({
      items: many(50),
      pagination: { page: 2, pages: 3, offset: 50, listed: 123, limit: 1000 },
    });

    it("says which page it is and links the previous and the next one", () => {
      const { html } = matchesPage(second);
      expect(html).toContain(
        "<p><strong>Strona 2 z 3</strong>: zamówienia 51–100 z 123. " +
          '<a href="/dopasowania?strona=3">Następna strona →</a></p>',
      );
      expect(html).toContain(
        '<nav aria-label="Strony listy"><p class="pages-status">Strona 2 z 3</p>' +
          '<p class="pages"><a href="/dopasowania" rel="prev">← Poprzednia strona</a>' +
          '<a href="/dopasowania?strona=3" rel="next">Następna strona →</a></p></nav>',
      );
      // `rel` once each: on the pager under the list, not on the line above it.
      expect(html.match(/rel="next"/g)).toHaveLength(1);
      expect(html.match(/rel="prev"/g)).toHaveLength(1);
      // The list numbering goes on from the previous page.
      expect(html).toContain('<ol class="matches" start="51"><li>');
      expect(html).not.toMatch(NO_SCRIPT);
    });

    it("has no previous link on the first page and no next link on the last", () => {
      const first = matchesPage(
        view({
          items: many(50),
          pagination: { page: 1, pages: 3, offset: 0, listed: 123, limit: 1000 },
        }),
      ).html;
      expect(first).toContain(
        "<p><strong>Strona 1 z 3</strong>: zamówienia 1–50 z 123. " +
          '<a href="/dopasowania?strona=2">Następna strona →</a></p>',
      );
      expect(first).not.toContain('rel="prev"');
      expect(first).toContain('<a href="/dopasowania?strona=2" rel="next">');
      expect(first).toContain('<ol class="matches"><li>');
      const last = matchesPage(
        view({
          items: many(23),
          pagination: { page: 3, pages: 3, offset: 100, listed: 123, limit: 1000 },
        }),
      ).html;
      expect(last).toContain("<p><strong>Strona 3 z 3</strong>: zamówienia 101–123 z 123.</p>");
      expect(last).toContain('<a href="/dopasowania?strona=2" rel="prev">');
      expect(last).not.toContain('rel="next"');
    });

    // PR-13 minors: the status on its own line, then the links, each a 44 px touch target.
    it("puts the page status on its own line and makes the page links touch targets", () => {
      const last = matchesPage(
        view({
          items: many(23),
          pagination: { page: 3, pages: 3, offset: 100, listed: 123, limit: 1000 },
        }),
      ).html;
      expect(last).toContain(
        '<nav aria-label="Strony listy"><p class="pages-status">Strona 3 z 3</p>' +
          '<p class="pages"><a href="/dopasowania?strona=2" rel="prev">← Poprzednia strona</a>' +
          "</p></nav>",
      );
      // No „Następna” anywhere on the last page, above or under the list.
      expect(last).not.toContain("Następna strona");
      expect(STYLESHEET).toContain(".pages-status{");
      expect(STYLESHEET).toMatch(/\.pages a\{[^}]*min-height:44px/);
      expect(STYLESHEET).toMatch(/\.pages a\{[^}]*display:inline-flex/);
    });

    it("shows no page line or pager for a list of one page", () => {
      const { html } = matchesPage(view());
      expect(html).not.toContain("Strona 1 z 1");
      expect(html).not.toContain("Strony listy");
      expect(html).not.toContain('rel="next"');
    });

    // PR-14: every page links the whole list's CSV (one file, not one per page), in
    // the short line of PR-12 — one line on a 390 px phone; no „pierwsze N z M”.
    it("links the whole list's CSV on page 2, in one short line under the page line", () => {
      const { html } = matchesPage(second);
      const csv =
        '<p><a href="/dopasowania.csv">Pobierz listę jako CSV</a> (Excel, Arkusze Google).</p>';
      expect(html).toContain(csv);
      expect(html).not.toContain("/dopasowania.csv?strona=");
      expect(html.match(/href="\/dopasowania\.csv/g)).toHaveLength(1);
      expect(html).not.toContain("pierwsze");
      expect(html).not.toContain("zawęź profil, aby mieć wszystkie");
      // Above the list: the page line, the window paragraph, the CSV line, then the cards.
      const at = [
        html.indexOf("<p><strong>Strona 2 z 3</strong>"),
        html.indexOf("<p>Pokazujemy zamówienia dodane do Radaru"),
        html.indexOf(csv),
        html.indexOf('<ol class="matches" start="51">'),
      ];
      expect(at.every((index) => index >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    });

    it("says nothing of other pages on the CSV link of a one-page list", () => {
      const { html } = matchesPage(view());
      expect(html).toContain(
        '<p><a href="/dopasowania.csv">Pobierz listę jako CSV</a> (Excel, Arkusze Google).</p>',
      );
      expect(html).not.toContain("Ta strona jako CSV");
    });

    it("links the same whole-list CSV on the last page", () => {
      const { html } = matchesPage(
        view({
          items: many(23),
          pagination: { page: 3, pages: 3, offset: 100, listed: 123, limit: 1000 },
        }),
      );
      expect(html).toContain(
        '<p><a href="/dopasowania.csv">Pobierz listę jako CSV</a> (Excel, Arkusze Google).</p>',
      );
      expect(html).not.toContain("Ta strona jako CSV");
      expect(html).not.toContain("/dopasowania.csv?strona=");
    });

    it("puts the pager under the list, before the rating paragraph", () => {
      const { html } = matchesPage(second);
      const at = [
        html.indexOf("</ol>"),
        html.indexOf('<nav aria-label="Strony listy">'),
        html.indexOf("<p>Oceń zamówienia przyciskami „Trafne” i „Nietrafne”"),
        html.indexOf("<p>Dane pochodzą z publicznych ogłoszeń."),
      ];
      expect(at.every((index) => index >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
    });

    it("counts the offers beyond the page limit on the last page only", () => {
      const lastPage = matchesPage(
        view({
          items: many(50),
          pagination: { page: 2, pages: 2, offset: 50, listed: 100, limit: 100 },
          more: 7,
        }),
      ).html;
      expect(lastPage).toContain("<p><strong>Strona 2 z 2</strong>: zamówienia 51–100 z 107.</p>");
      expect(lastPage).toContain(
        "Lista kończy się na 100 zamówieniach. Nie pokazujemy 7 kolejnych pasujących zamówień",
      );
      // Under the list on the last page: the overflow note, then the pager, then
      // the notes about the whole list.
      const at = [
        lastPage.indexOf("</ol>"),
        lastPage.indexOf("<p>Lista kończy się na 100 zamówieniach."),
        lastPage.indexOf('<nav aria-label="Strony listy">'),
        lastPage.indexOf("<p>Oceń zamówienia przyciskami „Trafne” i „Nietrafne”"),
        lastPage.indexOf("<p>Dane pochodzą z publicznych ogłoszeń."),
      ];
      expect(at.every((index) => index >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      const firstPage = matchesPage(
        view({
          items: many(50),
          pagination: { page: 1, pages: 2, offset: 0, listed: 100, limit: 100 },
          more: 7,
        }),
      ).html;
      expect(firstPage).toContain("zamówienia 1–50 z 107.");
      expect(firstPage).not.toContain("Lista kończy się");
    });
  });

  describe("rating (PR-12)", () => {
    const CSRF = "C".repeat(43);
    const rated = (
      value: Opportunity,
      verdict: "relevant" | "not_relevant" | null,
      next: string | null = null,
    ): MatchesView["items"][number] => ({
      ...cardOf(value),
      feedback: { opportunityId: value.id, verdict, csrf: CSRF, next },
    });

    it("puts the „Trafne”/„Nietrafne” form, with CSRF and the offer id, under each card", () => {
      const { html } = matchesPage(view({ items: [rated(offer, null)] }));
      expect(html).not.toMatch(NO_SCRIPT);
      expect(html).toContain(
        `<li id="oferta-${offer.id}"><article><h2>Modernizacja oświetlenia</h2>`,
      );
      expect(html).toContain(
        '<form method="post" action="/dopasowania/ocena" class="ocena">' +
          "<p>Czy to zamówienie pasuje?</p>" +
          `<input type="hidden" name="csrf" value="${CSRF}">` +
          `<input type="hidden" name="oferta" value="${offer.id}">` +
          '<button type="submit" name="werdykt" value="trafne" ' +
          'aria-label="Trafne: Modernizacja oświetlenia">Trafne</button>' +
          '<button type="submit" name="werdykt" value="nietrafne" ' +
          'aria-label="Nietrafne: Modernizacja oświetlenia">Nietrafne</button></form>',
      );
    });

    it("ends the card with the form, after „Więcej szczegółów” (D-030 order)", () => {
      // Also with a cut description, whose „Pełny opis” <details> comes first.
      const cut = { ...offer, description: "Wymiana opraw. ".repeat(40) };
      expect(cardOf(cut).fullDescription).not.toBeNull();
      for (const value of [offer, cut]) {
        const { html } = matchesPage(view({ items: [rated(value, null)] }));
        // The one card: from its anchor to the end of its article.
        const start = html.indexOf(`<li id="oferta-${value.id}">`);
        const card = html.slice(start, html.indexOf("</article>", start) + "</article>".length);
        const at = [
          card.indexOf('class="button"'),
          card.indexOf(`<summary>${MORE_LABEL}`),
          // The last </details>: the „Więcej szczegółów” one, not „Pełny opis”.
          card.lastIndexOf("</details>"),
          card.indexOf('<form method="post" action="/dopasowania/ocena"'),
          card.indexOf("</article>"),
        ];
        expect(start).toBeGreaterThanOrEqual(0);
        expect(at.every((index) => index >= 0)).toBe(true);
        expect(at).toEqual([...at].sort((a, b) => a - b));
        expect(at[4]).toBe(card.length - "</article>".length);
      }
    });

    it("shows the current rating and greys a „Nietrafne” card", () => {
      const relevant = matchesPage(view({ items: [rated(offer, "relevant")] })).html;
      expect(relevant).toContain("<p>Twoja ocena: <strong>trafne</strong>. Możesz ją zmienić.</p>");
      expect(relevant).not.toContain('class="nietrafne"');
      const notRelevant = matchesPage(view({ items: [rated(offer, "not_relevant")] })).html;
      expect(notRelevant).toContain(`<li id="oferta-${offer.id}"><article class="nietrafne"><h2>`);
      expect(notRelevant).toContain(
        "<p>Twoja ocena: <strong>nietrafne</strong>. Możesz ją zmienić.</p>",
      );
    });

    it("marks the current verdict's button pressed and bold, only once rated", () => {
      const relevant = matchesPage(view({ items: [rated(offer, "relevant")] })).html;
      expect(relevant).toContain(
        '<button type="submit" name="werdykt" value="trafne" ' +
          'aria-label="Trafne: Modernizacja oświetlenia" aria-pressed="true">' +
          "<strong>Trafne</strong></button>" +
          '<button type="submit" name="werdykt" value="nietrafne" ' +
          'aria-label="Nietrafne: Modernizacja oświetlenia" aria-pressed="false">' +
          "Nietrafne</button>",
      );
      const notRelevant = matchesPage(view({ items: [rated(offer, "not_relevant")] })).html;
      expect(notRelevant).toContain(
        'aria-label="Trafne: Modernizacja oświetlenia" aria-pressed="false">Trafne</button>',
      );
      expect(notRelevant).toContain(
        'aria-label="Nietrafne: Modernizacja oświetlenia" aria-pressed="true">' +
          "<strong>Nietrafne</strong></button>",
      );
      expect(matchesPage(view({ items: [rated(offer, null)] })).html).not.toContain("aria-pressed");
    });

    it("names the card that follows in the form (`nastepna`), the last card none", () => {
      const nextId = "00000000-0000-4000-8000-0000000000ff";
      const { html } = matchesPage(view({ items: [rated(offer, null, nextId)] }));
      expect(html).toContain(
        `<input type="hidden" name="oferta" value="${offer.id}">` +
          `<input type="hidden" name="nastepna" value="${nextId}">` +
          '<button type="submit" name="werdykt" value="trafne"',
      );
      expect(matchesPage(view({ items: [rated(offer, null)] })).html).not.toContain("nastepna");
    });

    it("escapes a hostile title in the buttons' labels", () => {
      const hostile = { ...offer, title: '"><img src=x onerror=alert(1)>' };
      const { html } = matchesPage(view({ items: [rated(hostile, null)] }));
      expect(html).not.toMatch(NO_MARKUP_FROM_DATA);
      expect(html).toContain('aria-label="Trafne: &quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    });

    it("explains the rating and links the CSV export", () => {
      const { html } = matchesPage(view({ items: [rated(offer, null)] }));
      const rating =
        "<p>Oceń zamówienia przyciskami „Trafne” i „Nietrafne” — pomagasz nam lepiej je " +
        "dobierać. Ocenione jako nietrafne są wyszarzone i na końcu listy.</p>";
      expect(html).toContain(rating);
      // Under the list, so the first card stays on a phone's first screen (the CSV link above it).
      expect(html.indexOf(rating)).toBeGreaterThan(html.indexOf("</ol>"));
      expect(html).toContain(
        '<p><a href="/dopasowania.csv">Pobierz listę jako CSV</a> (Excel, Arkusze Google).</p>',
      );
    });

    // PR-13: the CSV is the page shown; the old „pierwsze N z M” note is gone.
    it("links the whole list's CSV when the list has one page", () => {
      const items = Array.from({ length: 50 }, () => rated(offer, null));
      const { html } = matchesPage(
        view({
          items,
          pagination: { page: 1, pages: 1, offset: 0, listed: 50, limit: 50 },
          more: 7,
        }),
      );
      expect(html).toContain(
        '<p><a href="/dopasowania.csv">Pobierz listę jako CSV</a> (Excel, Arkusze Google).</p>',
      );
      expect(html).not.toContain("pierwsze 50");
    });

    it("sends the page back with the rating form, only past the first page", () => {
      const onSecond = matchesPage(
        view({
          items: [
            {
              ...cardOf(offer),
              feedback: { opportunityId: offer.id, verdict: null, csrf: CSRF, next: null, page: 2 },
            },
          ],
          pagination: { page: 2, pages: 2, offset: 50, listed: 51, limit: 1000 },
        }),
      ).html;
      expect(onSecond).toContain(
        `<input type="hidden" name="oferta" value="${offer.id}">` +
          '<input type="hidden" name="strona" value="2">',
      );
      const onFirst = matchesPage(
        view({
          items: [
            {
              ...cardOf(offer),
              feedback: { opportunityId: offer.id, verdict: null, csrf: CSRF, next: null, page: 1 },
            },
          ],
        }),
      ).html;
      expect(onFirst).not.toContain('name="strona"');
      expect(matchesPage(view({ items: [rated(offer, null)] })).html).not.toContain(
        'name="strona"',
      );
    });

    // PR-12 × PR-13: a page-2 card keeps the D-030 order, its form (with `strona`) last.
    it("ends a page-2 card with the form that returns to page 2, after „Więcej szczegółów”", () => {
      const nextId = "00000000-0000-4000-8000-0000000000ff";
      const cut = { ...offer, description: "Wymiana opraw. ".repeat(40) };
      const { html } = matchesPage(
        view({
          items: [
            {
              ...cardOf(cut),
              feedback: { opportunityId: cut.id, verdict: null, csrf: CSRF, next: nextId, page: 2 },
            },
          ],
          pagination: { page: 2, pages: 2, offset: 50, listed: 51, limit: 1000 },
        }),
      );
      const start = html.indexOf(`<li id="oferta-${cut.id}">`);
      const card = html.slice(start, html.indexOf("</article>", start) + "</article>".length);
      const at = [
        card.indexOf('class="button"'),
        card.indexOf(`<summary>${MORE_LABEL}`),
        card.lastIndexOf("</details>"),
        card.indexOf('<form method="post" action="/dopasowania/ocena"'),
        card.indexOf(
          `<input type="hidden" name="nastepna" value="${nextId}">` +
            '<input type="hidden" name="strona" value="2">',
        ),
        card.indexOf("</form></article>"),
      ];
      expect(start).toBeGreaterThanOrEqual(0);
      expect(at.every((index) => index >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(html).toContain(`<ol class="matches" start="51"><li id="oferta-${cut.id}">`);
    });
  });
});

describe("rating link pages (PR-12)", () => {
  const PATH = `/ocena/${"F".repeat(43)}/00000000-0000-4000-8000-000000000001/nietrafne`;

  const OPPOSITE = PATH.replace(/nietrafne$/, "trafne");
  const confirm = (
    title: string,
    verdict: "relevant" | "not_relevant",
    current: "relevant" | "not_relevant" | null,
  ) =>
    feedbackConfirmPage({
      title,
      verdict,
      current,
      path: verdict === "not_relevant" ? PATH : OPPOSITE,
      oppositePath: verdict === "not_relevant" ? OPPOSITE : PATH,
    });

  it("confirms with a POST form to the same path, the offer's title escaped", () => {
    const page = confirm("Remont <b>szkoły</b>", "not_relevant", null);
    expect(page.status).toBe(200);
    expect(page.html).not.toMatch(NO_SCRIPT);
    expect(page.html).not.toMatch(NO_MARKUP_FROM_DATA);
    expect(page.html).toContain(
      "<p>Zamówienie: <strong>Remont &lt;b&gt;szkoły&lt;/b&gt;</strong></p>",
    );
    expect(page.html).toContain(
      `<form method="post" action="${PATH}"><button type="submit">Zapisz ocenę: nietrafne</button></form>`,
    );
    expect(page.html).not.toContain("Obecna ocena");
  });

  it("shows the current rating when there is one", () => {
    const page = confirm("Remont szkoły", "not_relevant", "relevant");
    expect(page.html).toContain("<p>Obecna ocena: trafne.</p>");
    expect(page.html).toContain(
      `<form method="post" action="${PATH}"><button type="submit">Zapisz ocenę: nietrafne</button></form>`,
    );
  });

  it("offers only the other verdict when the offer already has the link's one", () => {
    const page = confirm("Remont szkoły", "not_relevant", "not_relevant");
    expect(page.status).toBe(200);
    expect(page.html).toContain("<p>To zamówienie ma już ocenę: nietrafne.</p>");
    expect(page.html).toContain(
      `<form method="post" action="${OPPOSITE}"><button type="submit">Zmień ocenę na: trafne</button></form>`,
    );
    expect(page.html).not.toContain(`action="${PATH}"`);
    expect(page.html).not.toContain("Obecna ocena");
    expect(page.html).not.toContain("Zapisz ocenę");
  });

  it("thanks after saving, naming the rating", () => {
    const page = feedbackSavedPage("relevant");
    expect(page.status).toBe(200);
    expect(page.html).toContain("Dziękujemy za ocenę");
    expect(page.html).toContain("<p>Zapisaliśmy ocenę: trafne.</p>");
    expect(page.html).toContain("<p>Możesz zamknąć tę kartę i wrócić do wiadomości.</p>");
    expect(page.html).toContain('<a href="/dopasowania">Pasujące zamówienia</a>');
    expect(page.html).not.toMatch(NO_SCRIPT);
  });
});

describe("profile page notices", () => {
  it("always shows the notification address, escaped", () => {
    const { html } = profilePage(
      { name: "Jan Kowalski", email: `o'brien&<syn>@example.invalid`, active: true },
      "c",
    );
    expect(html).toContain(
      "<p>Adres powiadomień: <strong>o&#39;brien&amp;&lt;syn&gt;@example.invalid</strong></p>",
    );
    expect(html).not.toContain("<syn>");
    const inactive = profilePage(
      { name: "Jan Kowalski", email: "kontakt@example.invalid", active: false },
      "c",
      "wypisano",
    ).html;
    expect(inactive).toContain(
      "<p>Adres powiadomień: <strong>kontakt@example.invalid</strong></p>",
    );
  });

  it("asks to check the new address after a change, without naming it in the notice", () => {
    const { html } = profilePage(
      { name: "Jan Kowalski", email: "biuro@example.invalid", active: true },
      "c",
      "zmieniono_email",
    );
    const notice = /<p class="notice" role="status">([^<]*)<\/p>/.exec(html)?.[1] ?? "";
    expect(notice).toContain("Sprawdź poniżej, czy nowy adres jest poprawny.");
    expect(notice).not.toContain("@");
    expect(html.indexOf('class="notice"')).toBeLessThan(html.indexOf("Adres powiadomień:"));
  });

  it("shows the notice once as a status message", () => {
    const saved = profilePage(
      { name: "Jan Kowalski", email: "kontakt@example.invalid", active: true },
      "c",
      "zapisano",
    ).html;
    // PR-13: when the change takes effect, and the link to see it.
    expect(saved).toContain(
      '<p class="notice" role="status">Zapisano zmiany profilu. Lista dopasowań pokazuje ' +
        "zmiany od razu, e-mail — od jutra. " +
        '<a href="/dopasowania">Zobacz pasujące zamówienia</a></p>',
    );
    const confirm = profilePage(
      { name: "Jan Kowalski", email: "kontakt@example.invalid", active: true },
      "c",
      "wyslano_potwierdzenie",
    ).html;
    expect(confirm).toContain(
      "Zapisano zmiany profilu. Lista dopasowań pokazuje zmiany od razu, e-mail — od jutra. " +
        "Na nowy adres wysłaliśmy link",
    );
    expect(confirm).toContain('<a href="/dopasowania">Zobacz pasujące zamówienia</a></p>');
    const changed = profilePage(
      { name: "Jan Kowalski", email: "kontakt@example.invalid", active: true },
      "c",
      "zmieniono_email",
    ).html;
    expect(changed).toContain("Adres e-mail został zmieniony");
    expect(
      profilePage(
        { name: "Jan Kowalski", email: "kontakt@example.invalid", active: false },
        "c",
        "wypisano",
      ).html,
    ).toContain("Wypisano z powiadomień.");
    expect(
      profilePage(
        { name: "Jan Kowalski", email: "kontakt@example.invalid", active: true },
        "c",
        "wlaczono",
      ).html,
    ).toContain("Włączono powiadomienia.");
    expect(
      profilePage({ name: "Jan Kowalski", email: "kontakt@example.invalid", active: true }, "c")
        .html,
    ).not.toContain('class="notice"');
  });

  it("links to the matches and the settings, and offers re-enabling when inactive", () => {
    const active = profilePage(
      { name: "Jan Kowalski", email: "kontakt@example.invalid", active: true },
      "c",
    ).html;
    expect(active).toContain('<a href="/dopasowania">Pasujące zamówienia</a>');
    expect(active).toContain('<a href="/profil/ustawienia">Ustawienia profilu</a>');
    expect(active).not.toContain("/profil/wlacz");
    const inactive = profilePage(
      { name: "Jan Kowalski", email: "kontakt@example.invalid", active: false },
      'c"',
    ).html;
    expect(inactive).toContain(
      '<form method="post" action="/profil/wlacz"><input type="hidden" name="csrf" value="c&quot;">' +
        '<button type="submit">Włącz ponownie powiadomienia</button></form>',
    );
    // The status line says it already; the button is the way back.
    expect(inactive).not.toContain("Powiadomienia są wyłączone.");
    expect(inactive).not.toContain("odpowiedz na ostatnią wiadomość");
  });
});

describe("copy", () => {
  // PR-13: counties left the form; stored ones (the operator's) are shown, not editable.
  it("has no counties field and tells the real effect of stored counties", () => {
    const plain = settingsPage(values, "c").html;
    expect(plain).not.toContain('name="counties"');
    expect(plain).not.toMatch(/powiat/i);
    const { html } = settingsPage(
      { ...values, region: REGION_ALL, voivodeships: [] },
      "c",
      {},
      null,
      false,
      ["warszawski zachodni", "<b>piaseczyński</b>"],
    );
    // PR-14: shorter, in the group's hint style (6 lines at 390 px, the box took 9).
    expect(html).toContain(
      '<p class="hint" id="powiaty-uwaga">Powiaty (ustawia obsługa): warszawski zachodni, ' +
        "&lt;b&gt;piaseczyński&lt;/b&gt;. Ogłoszenia nie podają powiatu, więc przy " +
        "„Cała Polska” tylko zamówienia z pasującą kategorią i słowem kluczowym. " +
        "Zmiana powiatów: odpowiedz na nasz e-mail.</p>",
    );
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain('name="counties"');
    expect(html).not.toMatch(NO_MARKUP_FROM_DATA);
  });

  // PR-13 minors: with CONTACT_EMAIL set, the note gives the address (PR-14: shorter words).
  it("gives the support address in the counties note when CONTACT_EMAIL is set", () => {
    const html = settingsPage(
      values,
      "c",
      {},
      null,
      false,
      ["warszawski zachodni"],
      'pomoc"@example.invalid',
    ).html;
    expect(html).toContain(
      '<p class="hint" id="powiaty-uwaga">Powiaty (ustawia obsługa): warszawski zachodni. ' +
        "Ogłoszenia nie podają powiatu, więc przy „Cała Polska” tylko zamówienia z pasującą " +
        "kategorią i słowem kluczowym. Zmiana powiatów: " +
        '<a href="mailto:pomoc&quot;@example.invalid">pomoc&quot;@example.invalid</a>.</p>',
    );
    expect(html).not.toContain("odpowiedz na");
    // No counties: no note and no address, CONTACT_EMAIL or not.
    const plain = settingsPage(values, "c", {}, null, false, [], "pomoc@example.invalid").html;
    expect(plain).not.toMatch(/powiat/i);
    expect(plain).not.toContain("mailto:");
  });

  it("describes the region group by the counties note, next to its errors", () => {
    const counties = ["warszawski zachodni"];
    const noted = settingsPage(values, "c", {}, null, false, counties).html;
    expect(noted).toContain('<fieldset aria-describedby="powiaty-uwaga"><legend>');
    const failed = settingsPage(
      values,
      "c",
      { voivodeships: ["Wybierz co najmniej jedno województwo."] },
      null,
      false,
      counties,
    ).html;
    expect(failed).toContain(
      '<fieldset aria-describedby="powiaty-uwaga wojewodztwo-blad"><legend>',
    );
    expect(failed).toContain('id="wojewodztwo-blad"');
    // Without counties the note id is never referenced.
    const plain = settingsPage(values, "c", {
      voivodeships: ["Wybierz co najmniej jedno województwo."],
    }).html;
    expect(plain).toContain('<fieldset aria-describedby="wojewodztwo-blad"><legend>');
    expect(plain).not.toContain("powiaty-uwaga");
  });

  it("sets the region radios apart from the voivodeship boxes", () => {
    const { html } = settingsPage(values, "c");
    expect(html).toContain('<div class="options region"><div class="option"><input type="radio"');
    expect(html.indexOf('class="options region"')).toBeLessThan(
      html.indexOf('name="voivodeships"'),
    );
    expect(STYLESHEET).toMatch(/\.region\{[^}]*border-bottom:1px solid var\(--line\)/);
  });

  it("suggests another browser when a login POST is refused", () => {
    const page = loginRefusedPage();
    expect(page.status).toBe(403);
    expect(page.html).toContain(
      "Odśwież stronę i spróbuj ponownie albo otwórz link w innej, aktualnej przeglądarce.",
    );
    expect(page.html).not.toMatch(NO_SCRIPT);
  });

  it("says the login lasts 30 days on this device", () => {
    expect(loginConfirmPage("t").html).toContain("logowanie jest ważne 30 dni na tym urządzeniu");
  });

  it("names the company on the unsubscribe confirmation, escaped", () => {
    const { html } = unsubscribeConfirmPage("t", "Jan Kowalski <Elektryka> & syn");
    expect(html).toContain(
      "<p>Firma: <strong>Jan Kowalski &lt;Elektryka&gt; &amp; syn</strong></p>",
    );
  });

  it("does not repeat that the link was used or expired on the 404 page", () => {
    const { html } = invalidLinkPage();
    expect(html).not.toContain("został już użyty albo wygasł");
    expect(html.match(/wygasł/g)).toHaveLength(1);
    expect(html).toContain('<a href="/">Strona główna</a>');
  });

  it.each([400, 403, 404, 405, 413, 415, 500] as const)("links back from the %i page", (status) => {
    const { html } = errorPage(status);
    expect(html).toContain('<a href="/profil">Twój profil</a> · <a href="/">Strona główna</a>');
  });
});

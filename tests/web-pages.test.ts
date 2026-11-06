import { describe, expect, it } from "vitest";
import type { CompanyProfile } from "../src/domain/company-profile.js";
import type { Opportunity } from "../src/domain/opportunity.js";
import { MVP_CATEGORIES, VOIVODESHIPS } from "../src/domain/vocabulary.js";
import { matchOpportunity } from "../src/matching/match.js";
import { digestItemView } from "../src/notifications/digest.js";
import {
  errorPage,
  invalidLinkPage,
  loginConfirmPage,
  loginRefusedPage,
  matchesBusyPage,
  matchesPage,
  matchesUnavailablePage,
  profilePage,
  settingsPage,
  unsubscribeConfirmPage,
  type MatchesView,
} from "../src/web/pages.js";
import type { ProfileFormValues } from "../src/web/profile-form.js";

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
  emailConfirm: "",
  categories: ["elektryka", "it"],
  voivodeships: ["mazowieckie"],
  counties: "warszawski zachodni",
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
    expect(html).toContain('<button type="submit">Zapisz</button>');
    expect(html).not.toMatch(NO_SCRIPT);
    expect(html).not.toContain("error-summary");
    expect(html).not.toContain("aria-invalid");

    // Every control has an id with exactly one <label for=…>.
    const ids = [
      ...html.matchAll(/<(?:input|textarea) (?:type="(?!hidden)[a-z]+" )?[^>]*id="([^"]+)"/g),
    ]
      .map((match) => match[1] ?? "")
      .filter((id) => id !== "");
    expect(ids).toHaveLength(6 + MVP_CATEGORIES.length + VOIVODESHIPS.length);
    for (const id of ids) {
      expect(html.match(new RegExp(`<label for="${id}">`, "g"))).toHaveLength(1);
    }
    for (const legend of ["Adres e-mail do powiadomień", "Kategorie", "Województwa"]) {
      expect(html).toContain(`<legend>${legend}</legend>`);
    }
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
    // The parser drops the newline right after <textarea>: the value is intact.
    expect(html).toContain('aria-describedby="slowa-opis">\noświetlenie\nlatarnie</textarea>');
  });

  it("re-renders an invalid form as 400 with an error summary linking to the fields", () => {
    const page = settingsPage(values, "c", {
      name: ["Podaj nazwę firmy."],
      emailConfirm: ["Wpisz nowy adres e-mail jeszcze raz."],
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
      ["email-powtorz", "Powtórz adres e-mail: Wpisz nowy adres e-mail jeszcze raz."],
      ["kategoria-1", "Kategorie: Wybierz co najmniej jedną kategorię."],
      ["slowa", "Słowa kluczowe: Wiersz 1: a"],
      ["slowa", "Słowa kluczowe: Wiersz 2: b"],
    ]);
    expect(tagWithId(html, "nazwa")).toContain(
      'aria-describedby="nazwa-opis nazwa-blad" aria-invalid="true"',
    );
    expect(tagWithId(html, "email-powtorz")).toContain(
      'aria-describedby="email-powtorz-opis email-powtorz-blad" aria-invalid="true"',
    );
    expect(tagWithId(html, "slowa")).toContain('aria-invalid="true"');
    expect(tagWithId(html, "email")).not.toContain("aria-invalid");
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
        emailConfirm: hostile,
        categories: [hostile],
        voivodeships: [hostile],
        counties: `</textarea>${hostile}`,
        includeKeywords: hostile,
        excludeKeywords: hostile,
      },
      hostile,
      { name: [hostile] },
    );
    expect(html).not.toMatch(NO_SCRIPT);
    // Only the three real closing tags: the value cannot end its textarea.
    expect(html.match(/<\/textarea>/g)).toHaveLength(3);
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

  function view(overrides: Partial<MatchesView> = {}): MatchesView {
    return {
      active: true,
      hasVoivodeships: true,
      hasCounties: false,
      stateAt: "2026-11-02 07:00",
      windowDays: 7,
      items: [digestItemView({ offer, reasons })],
      more: 0,
      truncated: false,
      ...overrides,
    };
  }

  it("shows each offer's title, buyer, location, deadline, publication date, reasons and source", () => {
    const page = matchesPage(view());
    expect(page.status).toBe(200);
    const { html } = page;
    expect(html).not.toMatch(NO_SCRIPT);
    expect(html).toContain('<ol class="matches"><li><article><h2>Modernizacja oświetlenia</h2>');
    for (const field of [
      "<dt>Zamawiający:</dt><dd>Gmina Przykładowa</dd>",
      "<dt>Lokalizacja:</dt><dd>Przykładowo, woj. mazowieckie</dd>",
      "<dt>Termin składania ofert:</dt><dd>2026-11-05 12:00 (czas polski)</dd>",
      "<dt>Data publikacji:</dt><dd>2026-10-30</dd>",
      "<dt>Dlaczego pasuje:</dt><dd>",
    ]) {
      expect(html).toContain(field);
    }
    expect(html).toContain(
      '<a href="https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1" ' +
        'rel="noopener noreferrer">Otwórz ogłoszenie w źródle (ezamowienia.gov.pl)</a>',
    );
    expect(html).toContain("ostatnich 7 dni");
    expect(html).toContain("Stan na 2026-11-02 07:00 (czas polski).");
    expect(html).not.toContain('class="note"');
    expect(html).toContain('<a href="/profil">Twój profil</a>');
  });

  it("shows a compact card: the essentials at once, the other fields inside <details>", () => {
    const full: Opportunity = {
      ...offer,
      description: "Wymiana opraw <LED> & słupów",
      contact: { name: "Anna Nowak", email: "zamowienia@example.invalid" },
    };
    const { html } = matchesPage(view({ items: [digestItemView({ offer: full, reasons })] }));
    expect(html).not.toMatch(NO_SCRIPT);
    const card = /<li><article>(.*?)<\/article><\/li>/s.exec(html)?.[1] ?? "";
    expect(card.match(/<details>/g)).toHaveLength(1);
    const [visible = "", folded = ""] = card.split("<details>");

    // At once: title, buyer, location, deadline, reasons, source link, in this order.
    const essentials = [
      "<h2>Modernizacja oświetlenia</h2><dl>",
      "<dt>Zamawiający:</dt><dd>Gmina Przykładowa</dd>",
      "<dt>Lokalizacja:</dt><dd>Przykładowo, woj. mazowieckie</dd>",
      "<dt>Termin składania ofert:</dt><dd>2026-11-05 12:00 (czas polski)</dd>",
      "<dt>Dlaczego pasuje:</dt><dd>",
      '<dt>Link:</dt><dd><a href="https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/1" ' +
        'rel="noopener noreferrer">Otwórz ogłoszenie w źródle (ezamowienia.gov.pl)</a></dd></dl>',
    ];
    const positions = essentials.map((part) => visible.indexOf(part));
    expect(positions.every((position) => position !== -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Folded: everything else, escaped, behind a native disclosure (no script).
    expect(folded.startsWith("<summary>Szczegóły ogłoszenia</summary><dl>")).toBe(true);
    expect(folded.endsWith("</dl></details>")).toBe(true);
    expect(
      folded.startsWith("<summary>Szczegóły ogłoszenia</summary><dl><dt>Data publikacji:"),
    ).toBe(true);
    for (const field of [
      "<dt>Data publikacji:</dt><dd>2026-10-30</dd>",
      "<dt>Kategoria:</dt><dd>",
      "<dt>Opis:</dt><dd>Wymiana opraw &lt;LED&gt; &amp; słupów</dd>",
      "<dt>Kontakt:</dt><dd>Anna Nowak, zamowienia@example.invalid</dd>",
    ]) {
      expect(folded).toContain(field);
      expect(visible).not.toContain(field.slice(0, field.indexOf("</dt>")));
    }
  });

  it("shows a Baza Konkurencyjności offer's attribution in the visible part, before the link", () => {
    const bk: Opportunity = {
      ...offer,
      sourceId: "bk",
      sourceUrl: "https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296920",
      externalId: "296920",
    };
    const { html } = matchesPage(view({ items: [digestItemView({ offer: bk, reasons })] }));
    const [visible = "", folded = ""] = html.split("<details>");
    expect(visible).toContain(
      "<dt>Źródło:</dt><dd>Baza Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej; " +
        "pobrano 2026-10-30; dane przetworzone: skrócone i ujednolicone</dd>" +
        '<dt>Link:</dt><dd><a href="https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/296920" ' +
        'rel="noopener noreferrer">Otwórz ogłoszenie w źródle ' +
        "(bazakonkurencyjnosci.funduszeeuropejskie.gov.pl)</a></dd></dl>",
    );
    expect(folded).not.toContain("Źródło");
    // A BZP card has none.
    expect(matchesPage(view()).html).not.toContain("<dt>Źródło:</dt>");
  });

  it("leaves a missing description and contact out of the details, as before", () => {
    const { html } = matchesPage(view());
    const folded = html.split("<details>")[1] ?? "";
    expect(folded).toContain("<dt>Data publikacji:</dt>");
    expect(html).not.toContain("<dt>Opis:</dt>");
    expect(html).not.toContain("<dt>Kontakt:</dt>");
  });

  it("shows a missing location as not given, in the visible part", () => {
    const nowhere: Opportunity = { ...offer, location: null };
    const { html } = matchesPage(view({ items: [digestItemView({ offer: nowhere, reasons })] }));
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
    const { html } = matchesPage(view({ items: [digestItemView({ offer: hostile, reasons })] }));
    expect(html).not.toMatch(NO_MARKUP_FROM_DATA);
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "<h2>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&quot;&amp;&#39;</h2>",
    );
    expect(html).toContain("<dd>&lt;b&gt;Gmina&lt;/b&gt;</dd>");
    expect(html).toContain("<dt>Link:</dt><dd>nie podano</dd>");
    expect(html).not.toContain("w źródle (");

    const quoted = { ...offer, sourceUrl: 'https://example.invalid/a?b="><script>' };
    const quotedHtml = matchesPage(
      view({ items: [digestItemView({ offer: quoted, reasons })] }),
    ).html;
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
    expect(withRegions).toContain(
      "dodaj kategorie, słowa kluczowe lub województwa (albo odznacz wszystkie województwa, " +
        "aby szukać w całej Polsce) albo usuń część słów wykluczających.",
    );
    // None ticked already means the whole country: no advice to add voivodeships.
    const wholeCountry = matchesPage(view({ items: [], hasVoivodeships: false })).html;
    expect(wholeCountry).toContain(
      ": dodaj kategorie lub słowa kluczowe albo usuń część słów wykluczających.",
    );
    expect(wholeCountry).not.toContain("województwa (");
    expect(withRegions).not.toContain("powiat");
    const counties = matchesPage(view({ items: [], hasCounties: true })).html;
    expect(counties).toContain(
      "<p>Wpisane powiaty nie zawężają listy: ogłoszenia nie podają jeszcze powiatu, więc " +
        "liczy się województwo. Powiat bez zaznaczonego województwa przepuszcza tylko " +
        "zamówienia pasujące jednocześnie kategorią i słowem kluczowym.</p>",
    );
    const countiesOnly = matchesPage(
      view({ items: [], hasCounties: true, hasVoivodeships: false }),
    ).html;
    expect(countiesOnly).toContain(
      "<p>Ogłoszenia nie podają jeszcze powiatu, więc same powiaty nie wystarczą: zaznacz " +
        "województwo w ustawieniach. Bez województwa pokazujemy tylko zamówienia pasujące " +
        "jednocześnie kategorią i słowem kluczowym.</p>",
    );
    expect(countiesOnly).not.toContain("Wpisane powiaty nie zawężają listy");
    expect(counties).not.toContain("same powiaty nie wystarczą");
  });

  it("says the list includes offers already sent by e-mail", () => {
    expect(matchesPage(view()).html).toContain(
      "<p>Lista obejmuje także zamówienia, które już wysłaliśmy e-mailem.</p>",
    );
  });

  it("notes an inactive profile, the overflow and a truncated candidate list", () => {
    const { html } = matchesPage(view({ active: false, more: 3, truncated: true }));
    expect(html).toContain(
      '<p class="note">Powiadomienia e-mail są wyłączone: tej listy nie wysyłamy.',
    );
    expect(html).toContain("I 3 kolejne pasujące zamówienia z dalszym terminem.");
    expect(html).toContain("Lista może być niepełna");
    expect(matchesPage(view({ more: 1 })).html).toContain(
      "I 1 kolejne pasujące zamówienie z dalszym terminem.",
    );
    expect(matchesPage(view({ more: 12 })).html).toContain(
      "I 12 kolejnych pasujących zamówień z dalszym terminem.",
    );
    expect(matchesPage(view()).html).not.toContain("z dalszym terminem");
  });

  it("asks to correct a stored profile it cannot match", () => {
    const { html } = matchesUnavailablePage();
    expect(html).toContain('<a href="/profil/ustawienia">ustawieniach profilu</a>');
  });

  it("asks to retry when another list is being computed (503)", () => {
    const page = matchesBusyPage();
    expect(page.status).toBe(503);
    expect(page.html).toContain(
      "<p>Trwa przygotowanie listy dopasowań — spróbuj za kilka sekund.</p>",
    );
    expect(page.html).toContain('<p><a href="/dopasowania">Spróbuj ponownie</a></p>');
    expect(page.html).toContain('<a href="/profil">Twój profil</a>');
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
    expect(saved).toContain('<p class="notice" role="status">Zapisano zmiany profilu.</p>');
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
  it("tells the counties' real effect next to the field", () => {
    const { html } = settingsPage(values, "c");
    expect(html).toContain(
      "Jeden powiat w wierszu, np. warszawski zachodni. Ogłoszenia nie podają jeszcze powiatu — " +
        "zamówienia dobieramy po województwie, więc zaznacz województwo. Sam powiat bez " +
        "województwa pokaże tylko zamówienia pasujące jednocześnie kategorią i słowem kluczowym.",
    );
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

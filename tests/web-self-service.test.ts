import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/db/database.js";
import { createLogger } from "../src/infrastructure/logger.js";
import { matchOpportunity } from "../src/matching/match.js";
import { EXAMPLE_PROFILE, exampleOffers, exampleView } from "../src/web/example.js";
import {
  emailChangedPage,
  emailConfirmPage,
  emailTakenPage,
  examplePage,
  homePage,
  invalidLinkPage,
  LINK_REQUESTED_TEXT,
  linkRequestedPage,
  linkRequestLimitPage,
  loginConfirmPage,
  profilePage,
  settingsPage,
} from "../src/web/pages.js";
import { formValuesFromStored } from "../src/web/profile-form.js";
import {
  LINK_FORM_MAX_BYTES,
  LINK_REQUESTS_PER_IP,
  startWebServer,
  type WebServer,
} from "../src/web/server.js";

/*
 * PR-10 without a database: the home page, the sample digest, the
 * „Wyślij mi link” form and the address confirmation pages, and the request
 * checks of their routes. The pool points at a closed port: every request
 * here is answered without it. Pseudonymised data only.
 */

const BASE = "https://radar.example.invalid";
const FORM = "application/x-www-form-urlencoded";
const TOKEN = "T".repeat(43);
const CSP =
  "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'";
const NO_SCRIPT = /<script|\sstyle=|<style|\son[a-z]+=/i;

describe("PR-10 pages", () => {
  it("home: what the service is, its two sources, how to start, the link form", () => {
    const page = homePage();
    expect(page.status).toBe(200);
    expect(page.html).toContain("<title>Radar Zamówień</title>");
    expect(page.html).toContain("codzienna wiadomość e-mail z nowymi zamówieniami publicznymi");
    expect(page.html).toContain("Biuletyn Zamówień Publicznych (platforma e-Zamówienia)");
    expect(page.html).toContain("Bazę Konkurencyjności");
    expect(page.html).not.toMatch(/BIP|szkoł|szpital/i);
    expect(page.html).toContain("Na razie profil firmy zakłada operator serwisu.");
    expect(page.html).toContain('<a href="/przyklad">');
    expect(page.html).toContain('<form method="post" action="/wyslij-link">');
    expect(page.html).toContain('<input type="email" name="email" value=""');
    expect(page.html).toContain('<button type="submit">Wyślij mi link</button>');
    // Without CONTACT_EMAIL there is no contact section and no address at all.
    expect(page.html).not.toContain("Kontakt");
    expect(page.html).not.toContain("mailto:");
    expect(page.html).not.toMatch(NO_SCRIPT);
  });

  it("home: shows CONTACT_EMAIL, escaped, when it is set", () => {
    const page = homePage({ contactEmail: "kontakt+a&b@example.invalid" });
    expect(page.html).toContain("<h2>Kontakt</h2>");
    expect(page.html).toContain(
      '<a href="mailto:kontakt+a&amp;b@example.invalid">kontakt+a&amp;b@example.invalid</a>',
    );
    expect(page.html).toContain("Na razie profil firmy zakłada operator serwisu: napisz na");
  });

  it("home: shows a malformed address again, escaped, with its error (400)", () => {
    const page = homePage({
      linkRequest: { value: '"><script>x</script>', message: "Podaj poprawny adres e-mail." },
    });
    expect(page.status).toBe(400);
    expect(page.html).toContain("<title>Błąd: Radar Zamówień</title>");
    expect(page.html).toContain("Błąd: Podaj poprawny adres e-mail.");
    expect(page.html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(page.html).toContain('aria-describedby="link-email-blad" aria-invalid="true"');
    expect(page.html).not.toContain("<script>");
  });

  it("answer every link request alike, and too many from one address with 429", () => {
    const requested = linkRequestedPage();
    expect(requested.status).toBe(200);
    expect(LINK_REQUESTED_TEXT).toBe(
      "Jeśli adres jest w bazie, link przyjdzie w ciągu kilku minut. Sprawdź też folder spam.",
    );
    expect(requested.html).toContain(`<p>${LINK_REQUESTED_TEXT}</p>`);
    const limited = linkRequestLimitPage();
    expect(limited.status).toBe(429);
    expect(limited.html).toContain("Spróbuj ponownie za godzinę");
    expect(limited.html).not.toContain("mailto:");
    expect(linkRequestLimitPage("kontakt+a&b@example.invalid").html).toContain(
      "<p>Pilna sprawa? Napisz do operatora serwisu: " +
        '<a href="mailto:kontakt+a&amp;b@example.invalid">kontakt+a&amp;b@example.invalid</a>.</p>',
    );
  });

  it("say on the login page, once, that the link works once, linking the home page", () => {
    const { html } = loginConfirmPage(TOKEN);
    expect(html).toContain(
      '<p>Link działa raz. Na innym urządzeniu poproś o nowy na <a href="/">stronie głównej</a>.</p>',
    );
    expect(html).toContain(
      "<p>Kliknij przycisk, aby otworzyć swój profil; logowanie jest ważne 30 dni na tym " +
        "urządzeniu.</p>",
    );
    expect(html.match(/działa/g)).toHaveLength(1);
  });

  it("add how to get in from a confirmation link to its 404 only, whatever the token was", () => {
    const hint =
      "<p>Link potwierdzający nowy adres? Dopóki adres nie jest potwierdzony, wpisz " +
      "dotychczasowy adres profilu — wyślemy na niego link do profilu, a nowy adres zapiszesz " +
      "ponownie w ustawieniach.</p>";
    const confirmLink = invalidLinkPage({ emailChangeLink: true });
    expect(confirmLink.status).toBe(404);
    expect(confirmLink.html).toContain(hint);
    // Before the form it refers to.
    expect(confirmLink.html.indexOf(hint)).toBeLessThan(
      confirmLink.html.indexOf('<form method="post" action="/wyslij-link">'),
    );
    expect(invalidLinkPage().html).not.toContain("Link potwierdzający nowy adres");
    expect(invalidLinkPage({ emailChangeLink: false }).html).toBe(invalidLinkPage().html);
  });

  it("confirm a new address with a button only; the outcome pages name no address", () => {
    const confirm = emailConfirmPage(TOKEN);
    expect(confirm.status).toBe(200);
    expect(confirm.html).toContain(`<form method="post" action="/potwierdz-email/${TOKEN}">`);
    expect(confirm.html).toContain('<button type="submit">Potwierdź adres</button>');
    expect(confirm.html).not.toMatch(NO_SCRIPT);
    expect(emailChangedPage().status).toBe(200);
    const taken = emailTakenPage();
    expect(taken.status).toBe(409);
    for (const page of [confirm, emailChangedPage(), taken]) {
      expect(page.html).not.toContain("@");
    }
    // CONTACT_EMAIL, when set, is the only address the 409 shows.
    expect(emailTakenPage("kontakt+a&b@example.invalid").html).toContain(
      "albo napisz do operatora serwisu: " +
        '<a href="mailto:kontakt+a&amp;b@example.invalid">kontakt+a&amp;b@example.invalid</a>.</p>',
    );
    expect(taken.html).toContain("albo napisz do operatora serwisu.</p>");
  });

  it("show a pending address, escaped, with a CSRF-protected „Anuluj zmianę”", () => {
    const pending = "<b>@example.invalid";
    const page = profilePage(
      {
        name: "Jan Kowalski",
        email: "kontakt@example.invalid",
        active: true,
        pendingEmail: pending,
      },
      "c",
    );
    expect(page.html).toContain(
      "Oczekuje na potwierdzenie: <strong>&lt;b&gt;@example.invalid</strong>",
    );
    expect(page.html).toContain(
      '<form method="post" action="/profil/anuluj-email"><input type="hidden" name="csrf" value="c">',
    );
    const none = profilePage(
      { name: "Jan Kowalski", email: "kontakt@example.invalid", active: true, pendingEmail: null },
      "c",
    );
    expect(none.html).not.toContain("Oczekuje na potwierdzenie");
    expect(none.html).not.toContain("/profil/anuluj-email");

    const values = formValuesFromStored({
      name: "Jan Kowalski",
      email: "kontakt@example.invalid",
      categories: ["elektryka"],
      includeKeywords: [],
      excludeKeywords: [],
      voivodeships: [],
      counties: [],
    });
    const settings = settingsPage(values, "c", {}, "biuro@example.invalid").html;
    expect(settings).toContain("Oczekuje na potwierdzenie: <strong>biuro@example.invalid</strong>");
    // Its own form, before (not inside) the profile form.
    const cancel = settings.indexOf('action="/profil/anuluj-email"');
    const save = settings.indexOf('action="/profil/ustawienia"');
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(save);
    expect(settings.slice(cancel, save)).toContain("</form>");
    expect(settingsPage(values, "c").html).not.toContain("Oczekuje na potwierdzenie");
    expect(settings).not.toContain("email_confirm");
  });

  it("say plainly that the link of a pending address expired, still with „Anuluj zmianę”", () => {
    const expired = profilePage(
      {
        name: "Jan Kowalski",
        email: "kontakt@example.invalid",
        active: true,
        pendingEmail: "<b>@example.invalid",
        pendingEmailExpired: true,
      },
      "c",
    ).html;
    const values = formValuesFromStored({
      name: "Jan Kowalski",
      email: "kontakt@example.invalid",
      categories: ["elektryka"],
      includeKeywords: [],
      excludeKeywords: [],
      voivodeships: [],
      counties: [],
    });
    const settings = settingsPage(values, "c", {}, "<b>@example.invalid", true).html;
    for (const html of [expired, settings]) {
      expect(html).toContain(
        "Link potwierdzający dla adresu <strong>&lt;b&gt;@example.invalid</strong> wygasł, więc " +
          "adres nie został zmieniony",
      );
      expect(html).toContain("wpisz ten adres ponownie w ustawieniach profilu i zapisz");
      expect(html).not.toContain("Oczekuje na potwierdzenie");
      expect(html).toContain(
        '<form method="post" action="/profil/anuluj-email"><input type="hidden" name="csrf" value="c">',
      );
    }
  });

  it("show the sample digest from made-up data, matched by the real rules", () => {
    const now = new Date("2026-11-09T09:00:00.000Z");
    for (const offer of exampleOffers(now)) {
      expect(matchOpportunity(offer, EXAMPLE_PROFILE).matched).toBe(true);
      expect(new URL(offer.sourceUrl).hostname).toMatch(/\.invalid$/);
      const email = offer.contact?.email;
      if (email !== undefined) expect(email).toMatch(/@[a-z.]+\.invalid$/);
    }
    const view = exampleView(now);
    expect(view.items.map((card) => card.title)).toEqual([
      "Wykonanie instalacji elektrycznej w budynku szkoleniowym",
      "Konserwacja oświetlenia drogowego",
      "Modernizacja oświetlenia ulicznego w Przykładowie",
      "Projekt oświetlenia boiska szkolnego",
    ]);
    const page = examplePage(view);
    expect(page.status).toBe(200);
    expect(page.html).toContain("<title>Przykładowe zestawienie — Radar Zamówień</title>");
    expect(page.html).toContain("są zmyślone");
    expect(page.html).toContain(
      "Profil: <strong>Jan Kowalski Elektryka</strong> — kategoria: Elektryka; " +
        "województwo: mazowieckie; słowa kluczowe: oświetlenie, instalacja elektryczna.",
    );
    expect(page.html).toContain(
      "<h2>Wykonanie instalacji elektrycznej w budynku szkoleniowym</h2>",
    );
    expect(page.html).toContain(
      "Baza Konkurencyjności, Ministerstwo Funduszy i Polityki Regionalnej",
    );
    expect(page.html).not.toMatch(NO_SCRIPT);
  });

  it("show the main states of a card on one sample page, dated relative to now", () => {
    // Monday 9 November 2026, 10:00 in Poland.
    const { html } = examplePage(exampleView(new Date("2026-11-09T09:00:00.000Z")));
    for (const state of [
      // a value and none
      "<dt>Wartość szacunkowa:</dt><dd>120\u00a0000,00 PLN (źródło nie podaje, netto czy brutto)</dd>",
      "<dt>Wartość szacunkowa:</dt><dd>nie podano</dd>",
      // an urgent, a normal and no deadline
      '<dt>Termin składania ofert:</dt><dd><strong class="pilne">PILNE</strong> 10.11.2026 (wt) 12:00 — jutro</dd>',
      "<dt>Termin składania ofert:</dt><dd>21.11.2026 (sob) 10:00 — za 12 dni</dd>",
      "<dt>Termin składania ofert:</dt><dd>15.11.2026 (nd) 09:00 — za 6 dni</dd>",
      "<dt>Termin składania ofert:</dt><dd>nie podano</dd>",
      // a cut description with the whole one folded
      "<summary>Pełny opis</summary>",
      // the region unknown and a CPV code outside the vocabulary
      "<li>region: nieznany — źródło nie podaje województwa</li>",
      "<li>kod CPV spoza naszej listy kategorii — kategorii nie da się sprawdzić</li>",
      // the button
      '<a class="button" href="https://bzp.przyklad.invalid/ogloszenie/1" rel="noopener noreferrer">Otwórz ogłoszenie</a>',
    ]) {
      expect(html).toContain(state);
    }
    expect(html.match(/<article>/g)).toHaveLength(4);
    expect(html.match(/Pełny opis/g)).toHaveLength(1);
    expect(html).not.toMatch(/Kowalsk[a-z]*@|\.pl\b|\.com\b/);
  });
});

describe("PR-10 routes without a database", () => {
  let server: WebServer;
  let url = "";
  const lines: string[] = [];
  const db = createDatabase("postgres://radar:not-a-real-password@127.0.0.1:1/radar");

  beforeAll(async () => {
    server = await startWebServer({
      db,
      publicBaseUrl: BASE,
      logger: createLogger("debug", (line) => lines.push(line)),
      host: "127.0.0.1",
      port: 0,
      cleanupIntervalMs: null,
      contactEmail: "kontakt@example.invalid",
      // Monday 9 November 2026, 10:00 in Poland: /przyklad dates are relative to it.
      now: () => new Date("2026-11-09T09:00:00.000Z"),
    });
    url = `http://127.0.0.1:${String(server.port)}`;
  });
  afterAll(async () => {
    await server.close();
    await db.destroy();
  });

  let ip = 0;
  /**
   * A „Wyślij mi link” POST as the proxy forwards it: the peer is loopback,
   * so the per-IP limit counts the X-Forwarded-For address. A new address
   * per call unless given, so the tests do not share a count.
   */
  function requestLink(
    body: string,
    headers: Record<string, string> = {},
    client = `198.51.100.${String((ip += 1))}`,
  ) {
    return fetch(`${url}/wyslij-link`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE, "x-forwarded-for": client, ...headers },
      body,
    });
  }

  function expectSecurityHeaders(response: Response) {
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  it("serves the home page with the configured contact and /przyklad, CSP unchanged", async () => {
    const home = await fetch(`${url}/`);
    expect(home.status).toBe(200);
    expectSecurityHeaders(home);
    expect(await home.text()).toContain('<a href="mailto:kontakt@example.invalid">');
    const example = await fetch(`${url}/przyklad`);
    expect(example.status).toBe(200);
    expectSecurityHeaders(example);
    const exampleHtml = await example.text();
    expect(exampleHtml).toContain("Modernizacja oświetlenia ulicznego w Przykładowie");
    // The injected clock dates the sample: tomorrow is urgent, the street lights in 12 days.
    expect(exampleHtml).toContain(
      '<strong class="pilne">PILNE</strong> 10.11.2026 (wt) 12:00 — jutro',
    );
    expect(exampleHtml).toContain("21.11.2026 (sob) 10:00 — za 12 dni");
    expect((await fetch(`${url}/przyklad`, { method: "HEAD" })).status).toBe(200);
  });

  it.each([
    ["GET", "/wyslij-link", "POST"],
    ["POST", "/przyklad", "GET, HEAD"],
    ["GET", "/profil/anuluj-email", "POST"],
    ["PUT", `/potwierdz-email/${TOKEN}`, "GET, HEAD, POST"],
  ])("answers 405 for %s %s with Allow", async (method, path, allow) => {
    const response = await fetch(`${url}${path}`, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow);
  });

  it("answers a valid address at once with the one page, whatever happens after", async () => {
    lines.length = 0;
    const response = await requestLink("email=+Kontakt%40Example.invalid+");
    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
    const html = await response.text();
    expect(html).toContain(`<p>${LINK_REQUESTED_TEXT}</p>`);
    expect(html).not.toContain("kontakt@example.invalid");
    // No sender configured here: logged as not sent, with a code only.
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.message === "access mail")).toMatchObject({
      level: "warn",
      kind: "login_link",
      outcome: "not_sent",
      errorCode: "email_not_configured",
    });
    expect(lines.join("")).not.toMatch(/kontakt|example\.invalid|198\.51\.100/i);
  });

  it("shows a malformed address again with a form error (400), without the database", async () => {
    lines.length = 0;
    for (const value of ["", "kontakt", "kontakt@", "a@b@example.invalid"]) {
      const response = await requestLink(`email=${encodeURIComponent(value)}`);
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain("Podaj poprawny adres e-mail, na przykład nazwa@firma.pl.");
      expect(html).toContain(`value="${value}"`);
    }
    expect(lines.join("")).not.toContain("access mail");
  });

  it("answers 400 for a form that is not exactly one email field", async () => {
    for (const body of [
      "",
      "e=x",
      "email=a%40example.invalid&email=b%40example.invalid",
      "email=x&csrf=y",
    ]) {
      expect((await requestLink(body)).status).toBe(400);
    }
  });

  it(`refuses a body over ${String(LINK_FORM_MAX_BYTES)} bytes with 413`, async () => {
    const response = await requestLink(`email=${"a".repeat(LINK_FORM_MAX_BYTES)}`);
    expect(response.status).toBe(413);
    expectSecurityHeaders(response);
  });

  it("refuses a POST that does not provably come from our own page (login CSRF)", async () => {
    for (const path of ["/wyslij-link", `/potwierdz-email/${TOKEN}`]) {
      for (const headers of [
        { origin: "https://evil.example.invalid" },
        { origin: "null" },
        { "sec-fetch-site": "cross-site" },
        {},
      ]) {
        const response = await fetch(`${url}${path}`, {
          method: "POST",
          headers: { "content-type": FORM, ...headers },
          body: path === "/wyslij-link" ? "email=kontakt%40example.invalid" : "",
        });
        expect(response.status).toBe(403);
        expect(await response.text()).toContain("Brak dostępu");
      }
    }
    // Same-origin without an Origin header is our own page.
    const ours = await fetch(`${url}/wyslij-link`, {
      method: "POST",
      headers: {
        "content-type": FORM,
        "sec-fetch-site": "same-origin",
        "x-forwarded-for": "192.0.2.200",
      },
      body: "email=kontakt%40example.invalid",
    });
    expect(ours.status).toBe(200);
  });

  it(`answers the request after ${String(LINK_REQUESTS_PER_IP)} per hour from one address with 429`, async () => {
    const client = "203.0.113.10";
    for (let i = 0; i < LINK_REQUESTS_PER_IP; i++) {
      // Malformed ones count too: the limit comes before the form.
      const body = i % 2 === 0 ? "email=kontakt%40example.invalid" : "email=x";
      expect([200, 400]).toContain((await requestLink(body, {}, client)).status);
    }
    const limited = await requestLink("email=kontakt%40example.invalid", {}, client);
    expect(limited.status).toBe(429);
    expectSecurityHeaders(limited);
    const limitedHtml = await limited.text();
    expect(limitedHtml).toContain("Za dużo próśb o link");
    expect(limitedHtml).toContain('<a href="mailto:kontakt@example.invalid">');
    // Another client is not affected; a client-sent header entry before the proxy's is ignored.
    expect((await requestLink("email=kontakt%40example.invalid", {}, "203.0.113.11")).status).toBe(
      200,
    );
    expect(
      (await requestLink("email=kontakt%40example.invalid", {}, `203.0.113.12, ${client}`)).status,
    ).toBe(429);
  });

  it("counts an IPv6 client by its /64, so rotating addresses does not reset the limit", async () => {
    for (let i = 1; i <= LINK_REQUESTS_PER_IP; i++) {
      const client = `2001:db8:a:b::${i.toString(16)}`;
      expect((await requestLink("email=x", {}, client)).status).toBe(400);
    }
    expect((await requestLink("email=x", {}, "2001:DB8:A:B:FFFF::1")).status).toBe(429);
    expect((await requestLink("email=x", {}, "2001:db8:a:c::1")).status).toBe(400);
  });

  it("shows the neutral 404 for a malformed confirmation link, GET or POST", async () => {
    const hint = "Link potwierdzający nowy adres?";
    for (const path of ["/potwierdz-email/x", `/potwierdz-email/${TOKEN}x`]) {
      const shown = await fetch(`${url}${path}`);
      expect(shown.status).toBe(404);
      const shownHtml = await shown.text();
      expect(shownHtml).toContain('<form method="post" action="/wyslij-link">');
      expect(shownHtml).toContain(hint);
      const posted = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": FORM, origin: BASE },
        body: "",
      });
      expect(posted.status).toBe(404);
      expect(await posted.text()).toContain(hint);
    }
    // Only on this route: the 404 of a login or unsubscribe link has no such sentence.
    for (const path of ["/dostep/x", "/wypis/x"]) {
      const other = await fetch(`${url}${path}`);
      expect(other.status).toBe(404);
      expect(await other.text()).not.toContain(hint);
    }
    expect((await fetch(`${url}/potwierdz-email/${TOKEN}/x`)).status).toBe(404);
    // The confirmation form has no fields.
    const extra = await fetch(`${url}/potwierdz-email/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: "token=x",
    });
    expect(extra.status).toBe(400);
  });

  it("answers 401 to „Anuluj zmianę” without a session", async () => {
    const response = await fetch(`${url}/profil/anuluj-email`, {
      method: "POST",
      headers: { "content-type": FORM, origin: BASE },
      body: "csrf=x",
    });
    expect(response.status).toBe(401);
  });
});

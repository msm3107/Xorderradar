import { CATEGORY_LABELS, VOIVODESHIPS, MVP_CATEGORIES } from "../domain/vocabulary.js";
import type { FeedbackVerdict } from "../infrastructure/db/schema.js";
import { escapeHtml } from "../infrastructure/html.js";
import {
  FULL_DESCRIPTION_LABEL,
  DESCRIPTION_LABEL,
  MATCH_DETAILS_LABEL,
  OPEN_LABEL,
  URGENT_WORD,
  type CardRow,
  type OfferCard,
} from "../notifications/card.js";
import { plural, RATE_NOT_RELEVANT_LABEL, RATE_RELEVANT_LABEL } from "../notifications/digest.js";
import { verdictWord } from "./links.js";
import {
  FIELD_LABELS,
  FIELD_ORDER,
  REGION_ALL,
  REGION_SELECTED,
  type ProfileFormErrors,
  type ProfileFormField,
  type ProfileFormValues,
} from "./profile-form.js";
import type { Notice } from "./session.js";

/**
 * The HTML pages of the web access (PR-06A, PR-06B, PR-10). Polish, server-rendered, no
 * script and no inline style (the CSP forbids both): every value is escaped
 * with the shared escapeHtml. Forms are plain POST forms with labelled real
 * buttons. A page never shows a token except inside the hidden field of the
 * form that submits it.
 */

export interface Page {
  readonly status: number;
  readonly html: string;
}

/**
 * The one stylesheet, served as /styl.css. One accent colour; a dark scheme
 * for `prefers-color-scheme: dark`. Contrast (WCAG AA, ≥ 4.5:1 for text):
 * light — text #1a1a1a on #fff / card #f4f7fb ≥ 16:1, accent #1d5fb4 on
 * #f4f7fb 5.8:1, button text #fff on the accent 6.3:1, hints #555 6.9:1;
 * dark — text #e8eaed on #1b2028 13.6:1, accent #8ab4f8 on the card 7.8:1,
 * button text #0b1a2e on the accent 8.3:1, hints #b8bcc2 8.6:1. The card
 * grid falls back to one column under 30rem (a 390 px phone). The profile
 * form's checkboxes and radios (PR-13): three columns, two under 30rem; each
 * label is a touch target of at least 44 px (WCAG 2.5.5), as are the links of
 * /dopasowania's pager; a line sets the region radios apart from the
 * voivodeships.
 */
export const STYLESHEET = `:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--card:#f4f7fb;--line:#c3cedb;--accent:#1d5fb4;--on-accent:#fff;--muted:#555;--error:#b00020;--ok:#1a7f37;--ok-bg:#f0f7f1;--warn:#8a6d00;--warn-bg:#fbf6e6}
@media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--bg:#121417;--card:#1b2028;--line:#3a4452;--accent:#8ab4f8;--on-accent:#0b1a2e;--muted:#b8bcc2;--error:#ff8a80;--ok:#7ee2a8;--ok-bg:#14261a;--warn:#f0c674;--warn-bg:#2a2410}}
body{font-family:system-ui,sans-serif;line-height:1.5;max-width:44rem;margin:0 auto;padding:0 1rem;color:var(--fg);background:var(--bg)}
a{color:var(--accent)}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.site{border-bottom:3px solid var(--accent);padding:.8rem 0;margin-bottom:1rem}
.site a{font-weight:bold;font-size:1.1rem;text-decoration:none}
footer.site{border-bottom:0;border-top:1px solid var(--line);margin:2rem 0 1rem;color:var(--muted);font-size:.9rem}
h1{font-size:1.4rem}
form{margin:1rem 0}
button{font:inherit;padding:.5rem 1rem;cursor:pointer}
.status{font-weight:bold}
.notice{border-left:.3rem solid var(--ok);padding:.5rem 1rem;background:var(--ok-bg)}
.note{border-left:.3rem solid var(--warn);padding:.5rem 1rem;background:var(--warn-bg)}
.error-summary{border:.2rem solid var(--error);padding:.5rem 1rem;margin:1rem 0}
.error-summary h2{font-size:1.1rem;margin:.3rem 0}
.error{color:var(--error);font-weight:bold;margin:.3rem 0}
.hint{color:var(--muted);margin:.3rem 0;font-size:.9rem}
.field{margin:1rem 0}
fieldset{border:1px solid var(--line);margin:1rem 0;padding:.3rem .6rem}
legend{font-weight:bold;padding:0 .3rem}
label{display:block;font-weight:bold}
.options{display:grid;grid-template-columns:repeat(3,1fr);gap:0 .5rem}
.option{display:flex;align-items:center}
.option input{flex:none;width:1.2rem;height:1.2rem;margin:0}
.option label{flex:1;display:flex;align-items:center;min-height:44px;font-weight:normal;line-height:1.25;padding-left:.4rem}
.primary{min-height:44px;padding:.6rem 2.5rem;border:0;border-radius:.3rem;background:var(--accent);color:var(--on-accent);font-weight:bold}
.region{border-bottom:1px solid var(--line);padding-bottom:.3rem;margin-bottom:.3rem}
.pages-status{margin:1.5rem 0 .5rem}
.pages{display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin:.5rem 0 1.5rem}
.pages a{display:inline-flex;align-items:center;min-height:44px;padding:0 .8rem;border:1px solid var(--line);border-radius:.3rem}
input[type=text],input[type=email],textarea{box-sizing:border-box;width:100%;font:inherit;padding:.4rem;color:var(--fg);background:var(--bg);border:1px solid var(--line)}
[aria-invalid=true]{border:.15rem solid var(--error)}
.matches{list-style:none;padding:0}
.matches article{border:1px solid var(--line);border-left:.3rem solid var(--accent);border-radius:.4rem;background:var(--card);padding:.2rem 1rem .8rem;margin:1rem 0}
.matches h2{font-size:1.1rem;margin:.6rem 0 .5rem}
.matches dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem .8rem;margin:0}
.matches dt{font-weight:bold}
.matches dd{margin:0;overflow-wrap:anywhere}
.pilne{color:var(--error)}
.button{display:inline-block;padding:.5rem 1.1rem;border-radius:.3rem;background:var(--accent);color:var(--on-accent);font-weight:bold;text-decoration:none}
.matches details{margin:.4rem 0}
.matches summary{cursor:pointer;color:var(--accent)}
.matches ul{margin:.3rem 0;padding-left:1.2rem}
.matches article.nietrafne{border-left-color:var(--line);background:var(--bg);color:var(--muted)}
.matches .ocena{margin:.6rem 0 0}
.matches .ocena p{margin:0 0 .3rem}
.matches .ocena button{margin-right:.5rem}
@media (max-width:30rem){.matches dl{grid-template-columns:1fr}.matches dd{margin-bottom:.4rem}.options{grid-template-columns:repeat(2,1fr)}}
nav p{margin:1.5rem 0}
h2{font-size:1.15rem;margin:1.5rem 0 .3rem}
`;

const SITE_NAME = "Radar Zamówień";
/** Every page's footer: what the service is and where its data come from (the home page's sources). */
const SITE_FOOTER =
  "Radar Zamówień — nowe zamówienia publiczne dobrane do profilu firmy. Dane z publicznych " +
  "ogłoszeń: Biuletyn Zamówień Publicznych i Baza Konkurencyjności.";

/**
 * How a customer gets back in: the links are single-use and expire, and the
 * „Wyślij mi link” form under this sentence sends a new one (D-031). One
 * shared sentence, so the 404 stays the same page for every token failure.
 */
const NEW_LINK_HINT =
  "Jeśli link został już użyty lub wygasł, wpisz adres e-mail profilu — wyślemy nowy link.";

/**
 * The extra sentence of the 404 on the /potwierdz-email/… route (decided by
 * the route, never by the token's state): the address it confirmed is not
 * the profile's until confirmed, so the form needs the one the messages go
 * to. True whether or not the change was confirmed meanwhile.
 */
const EMAIL_CHANGE_LINK_HINT =
  "Link potwierdzający nowy adres? Dopóki adres nie jest potwierdzony, wpisz dotychczasowy " +
  "adres profilu — wyślemy na niego link do profilu, a nowy adres zapiszesz ponownie " +
  "w ustawieniach.";

/**
 * The extra sentence of the 404 on the /ocena/… route (PR-12, decided by the
 * route only): the same for every rating-link failure.
 */
const FEEDBACK_LINK_HINT =
  "Zamówienia ocenisz też na stronie „Pasujące zamówienia” po zalogowaniu.";

/** What every „Wyślij mi link” request is answered with (D-031), whatever the address. */
export const LINK_REQUESTED_TEXT =
  "Jeśli adres jest w bazie, link przyjdzie w ciągu kilku minut. Sprawdź też folder spam.";

/** The „Wyślij mi link” form sent back with a syntax error of its one field. */
export interface LinkRequestError {
  /** The submitted value, shown again (escaped). */
  readonly value: string;
  readonly message: string;
}

/**
 * The „Wyślij mi link” form (D-031): one e-mail field and a button, no
 * session and so no CSRF token — its POST is checked like the login one.
 */
function linkRequestForm(error: LinkRequestError | null = null): string {
  const invalid = error !== null;
  return (
    '<form method="post" action="/wyslij-link">' +
    '<div class="field"><label for="link-email">Adres e-mail profilu</label>' +
    (invalid
      ? `<p class="error" id="link-email-blad"><span>Błąd: ${escapeHtml(error.message)}</span></p>`
      : "") +
    `<input type="email" name="email" value="${escapeHtml(error?.value ?? "")}" ` +
    'maxlength="254" required autocomplete="email" id="link-email"' +
    (invalid ? ' aria-describedby="link-email-blad" aria-invalid="true"' : "") +
    ">" +
    "</div>" +
    '<button type="submit">Wyślij mi link</button></form>'
  );
}

/**
 * Counties: kept in the profile, but no source gives an offer's county yet, so
 * they never narrow and never match (src/matching/match.ts, regionReason). A
 * profile with counties and no voivodeship has an unknown region for every
 * offer: only category + keyword reach MATCH_THRESHOLD then. Since PR-13 only
 * the operator sets them (docs/RUNBOOK.md): the form has no counties field, so
 * no page tells the customer to edit them.
 */
const COUNTIES_NOTE = {
  withVoivodeships:
    "Powiaty zapisane w profilu nie zawężają listy: ogłoszenia nie podają jeszcze powiatu, " +
    "więc liczy się województwo.",
  withoutVoivodeships:
    "Profil ma zapisane powiaty, a ogłoszenia nie podają jeszcze powiatu: bez zaznaczonego " +
    "województwa pokazujemy tylko zamówienia pasujące jednocześnie kategorią i słowem " +
    "kluczowym. Wybierz w ustawieniach „Wybrane województwa” i zaznacz województwo.",
} as const;

/**
 * The way back after an unsubscribe without a session (the one-click link):
 * the operator re-enables. A signed-in customer has the button on /profil
 * instead (PR-06B).
 */
const RESUBSCRIBE_HINT =
  "Jeśli to pomyłka, odpowiedz na ostatnią wiadomość — włączymy powiadomienia ponownie.";

/** `head`: extra elements of <head> (the 503's refresh); built by this module only. */
function layout(title: string, body: readonly string[], head: readonly string[] = []): string {
  return [
    "<!doctype html>",
    '<html lang="pl">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // strict-origin, not no-referrer: with no-referrer a browser sends
    // `Origin: null` on our own form POSTs (Fetch standard), and the Origin
    // checks would refuse them. A Referer carries the origin only, never a
    // path, so a token in /dostep/… or /wypis/… cannot leak through it.
    '<meta name="referrer" content="strict-origin">',
    // The site name once: also in „Błąd: Radar Zamówień”, the home page with a form error.
    `<title>${escapeHtml(title.endsWith(SITE_NAME) ? title : `${title} — ${SITE_NAME}`)}</title>`,
    '<link rel="stylesheet" href="/styl.css">',
    ...head,
    "</head>",
    "<body>",
    `<header class="site">${link("/", SITE_NAME)}</header>`,
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    ...body,
    "</main>",
    `<footer class="site">${paragraph(SITE_FOOTER)}</footer>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function link(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/** CONTACT_EMAIL as a mailto link; a page leaves the contact out without it. */
function mailLink(address: string): string {
  return link(`mailto:${address}`, address);
}

function homeLink(): string {
  return `<nav><p>${link("/", "Strona główna")}</p></nav>`;
}

/** Ways back from a page that is not the profile itself. */
function backLinks(): string {
  return `<nav><p>${link("/profil", "Twój profil")} · ${link("/", "Strona główna")}</p></nav>`;
}

/** `buttonClass`: "primary" for the one main action of a page (PR-13: „Zapisz”). */
function form(
  action: string,
  fields: readonly string[],
  button: string,
  buttonClass: "primary" | null = null,
): string {
  return (
    `<form method="post" action="${escapeHtml(action)}">` +
    fields.join("") +
    `<button type="submit"${buttonClass === null ? "" : ` class="${buttonClass}"`}>` +
    `${escapeHtml(button)}</button></form>`
  );
}

export interface HomeOptions {
  /** CONTACT_EMAIL; the contact section is left out without it. */
  readonly contactEmail?: string | null;
  /** The „Wyślij mi link” form sent back with a syntax error: a 400. */
  readonly linkRequest?: LinkRequestError;
}

/** GET / (PR-10): what the service is, its sources, how to start, the link form, contact. */
export function homePage(options: HomeOptions = {}): Page {
  const contact = options.contactEmail ?? null;
  const error = options.linkRequest ?? null;
  return {
    status: error === null ? 200 : 400,
    html: layout(error === null ? SITE_NAME : `Błąd: ${SITE_NAME}`, [
      paragraph(
        "Radar Zamówień to codzienna wiadomość e-mail z nowymi zamówieniami publicznymi " +
          "dobranymi do profilu firmy: jej branży, regionu i słów kluczowych.",
      ),
      `<p>${link("/przyklad", "Zobacz przykładowe zestawienie")}</p>`,
      "<h2>Skąd są zamówienia</h2>",
      paragraph(
        "Codziennie sprawdzamy dwa publiczne źródła: Biuletyn Zamówień Publicznych " +
          "(platforma e-Zamówienia) i Bazę Konkurencyjności (zamówienia w projektach " +
          "z funduszy europejskich).",
      ),
      "<h2>Jak zacząć</h2>",
      contact === null
        ? paragraph("Na razie profil firmy zakłada operator serwisu.")
        : `<p>Na razie profil firmy zakłada operator serwisu: napisz na ${mailLink(contact)}, ` +
          "podając nazwę firmy, branżę i region.</p>",
      "<h2>Masz już profil?</h2>",
      paragraph(
        "Najprościej: użyj linku „Twój profil” z ostatniej wiadomości. Link nie działa albo " +
          "nie masz wiadomości pod ręką? Wpisz adres e-mail, na który przychodzą wiadomości " +
          "z Radaru — wyślemy nowy link.",
      ),
      linkRequestForm(error),
      ...(contact === null ? [] : ["<h2>Kontakt</h2>", `<p>${mailLink(contact)}</p>`]),
    ]),
  };
}

/** POST /wyslij-link: one page whatever the address was (D-031); never says whether it exists. */
export function linkRequestedPage(): Page {
  return {
    status: 200,
    html: layout("Sprawdź pocztę", [
      paragraph(LINK_REQUESTED_TEXT),
      paragraph("Link działa raz przez 7 dni."),
      homeLink(),
    ]),
  };
}

/**
 * 429 on POST /wyslij-link: too many requests from this IP address within
 * the hour (D-031). `contactEmail`: CONTACT_EMAIL, shown when set.
 */
export function linkRequestLimitPage(contactEmail: string | null = null): Page {
  return {
    status: 429,
    html: layout("Za dużo próśb o link", [
      paragraph(
        "Z tego połączenia poproszono w ciągu godziny o zbyt wiele linków. Spróbuj ponownie " +
          "za godzinę albo użyj linku z ostatniej wiadomości.",
      ),
      ...(contactEmail === null
        ? []
        : [`<p>Pilna sprawa? Napisz do operatora serwisu: ${mailLink(contactEmail)}.</p>`]),
      homeLink(),
    ]),
  };
}

/** GET /dostep/<token>: confirms the login; only the POST uses the link up. */
export function loginConfirmPage(token: string): Page {
  return {
    status: 200,
    html: layout("Logowanie", [
      paragraph(
        "Kliknij przycisk, aby otworzyć swój profil; logowanie jest ważne 30 dni na tym " +
          "urządzeniu.",
      ),
      form("/dostep", [hidden("token", token)], "Zaloguj się"),
      `<p>Link działa raz. Na innym urządzeniu poproś o nowy na ${link("/", "stronie głównej")}.</p>`,
    ]),
  };
}

export interface InvalidLinkOptions {
  /** The route is /potwierdz-email/…: adds EMAIL_CHANGE_LINK_HINT. Never the token's state. */
  readonly emailChangeLink?: boolean;
  /** The route is /ocena/…: adds FEEDBACK_LINK_HINT. Never the token's or the offer's state. */
  readonly feedbackLink?: boolean;
}

/**
 * One page for an unknown, used and expired link alike: nothing tells them
 * apart. Its only variant depends on the route of the link.
 */
export function invalidLinkPage(options: InvalidLinkOptions = {}): Page {
  return {
    status: 404,
    html: layout("Link jest nieaktywny", [
      paragraph("Ten link nie działa."),
      paragraph(NEW_LINK_HINT),
      ...(options.emailChangeLink === true ? [paragraph(EMAIL_CHANGE_LINK_HINT)] : []),
      ...(options.feedbackLink === true ? [paragraph(FEEDBACK_LINK_HINT)] : []),
      linkRequestForm(),
      homeLink(),
    ]),
  };
}

export function loginRequiredPage(): Page {
  return {
    status: 401,
    html: layout("Zaloguj się", [
      paragraph("Ta strona wymaga zalogowania. Użyj linku „Twój profil” z ostatniej wiadomości."),
      paragraph(NEW_LINK_HINT),
      linkRequestForm(),
      homeLink(),
    ]),
  };
}

/** GET /potwierdz-email/<token>: confirms the new address; only the POST changes it (D-031). */
export function emailConfirmPage(token: string): Page {
  return {
    status: 200,
    html: layout("Potwierdź nowy adres e-mail", [
      paragraph(
        "Kliknij przycisk, aby wiadomości Radaru Zamówień przychodziły od teraz na ten adres. " +
          "Link działa raz. Linki z wcześniejszych wiadomości przestaną działać, a inne " +
          "urządzenia zostaną wylogowane.",
      ),
      form(`/potwierdz-email/${token}`, [], "Potwierdź adres"),
    ]),
  };
}

/** The address was confirmed from a browser without the profile's session. */
export function emailChangedPage(): Page {
  return {
    status: 200,
    html: layout("Adres zmieniony", [
      paragraph(
        "Adres e-mail profilu został zmieniony: kolejne wiadomości przyjdą na nowy adres. " +
          "Linki z wcześniejszych wiadomości przestały działać.",
      ),
      paragraph("Aby otworzyć profil, poproś o link na stronie głównej."),
      homeLink(),
    ]),
  };
}

/**
 * 409: another profile uses the address by now. Nothing changed; the page
 * names neither the address nor the other profile — only CONTACT_EMAIL
 * (`contactEmail`) when set.
 */
export function emailTakenPage(contactEmail: string | null = null): Page {
  const text =
    "Tego adresu nie można przypisać do profilu, więc adres e-mail profilu się nie zmienił. " +
    "Wybierz inny adres w ustawieniach profilu albo napisz do operatora serwisu";
  return {
    status: 409,
    html: layout("Nie zmieniono adresu", [
      contactEmail === null
        ? paragraph(`${text}.`)
        : `<p>${escapeHtml(text)}: ${mailLink(contactEmail)}.</p>`,
      homeLink(),
    ]),
  };
}

export interface ProfileView {
  readonly name: string;
  /** The current notification address, read with the session's profile. */
  readonly email: string;
  readonly active: boolean;
  /** A new address waiting for its confirmation (D-031). */
  readonly pendingEmail?: string | null;
  /** Its confirmation link expired or was revoked (the address is still not confirmed). */
  readonly pendingEmailExpired?: boolean;
}

/**
 * When a saved profile takes effect (PR-13): /dopasowania computes on each
 * request, the digest goes out once a day.
 */
export const SAVED_EFFECT_TEXT = "Lista dopasowań pokazuje zmiany od razu, e-mail — od jutra.";

/** What /profil says once after a form (session.ts, NOTICE_COOKIE). */
const NOTICE_TEXT: Readonly<Record<Notice, string>> = {
  zapisano: `Zapisano zmiany profilu. ${SAVED_EFFECT_TEXT}`,
  zmieniono_email:
    "Adres e-mail został zmieniony na potwierdzony adres: linki z wcześniejszych wiadomości " +
    "przestały działać, a inne urządzenia zostały wylogowane. Sprawdź poniżej, czy nowy adres " +
    "jest poprawny.",
  wypisano: "Wypisano z powiadomień. Nie wyślemy kolejnych wiadomości.",
  wlaczono:
    "Włączono powiadomienia. Nowe pasujące zamówienia przyjdą w najbliższej codziennej wiadomości.",
  wyslano_potwierdzenie:
    `Zapisano zmiany profilu. ${SAVED_EFFECT_TEXT} Na nowy adres wysłaliśmy link ` +
    "potwierdzający, ważny 24 godziny. Do potwierdzenia wiadomości przychodzą na dotychczasowy " +
    "adres.",
  anulowano_zmiane: "Anulowano zmianę adresu e-mail. Wysłany link potwierdzający już nie działa.",
};

/** The link after a saved profile's notice (PR-13): straight to the changed list. */
const NOTICE_LINK: Partial<Readonly<Record<Notice, string>>> = {
  zapisano: link("/dopasowania", "Zobacz pasujące zamówienia"),
  wyslano_potwierdzenie: link("/dopasowania", "Zobacz pasujące zamówienia"),
};

/** The notice paragraph: its fixed text escaped, then its fixed link, if any. */
function noticeParagraph(notice: Notice): string {
  const after = NOTICE_LINK[notice];
  return (
    `<p class="notice" role="status">${escapeHtml(NOTICE_TEXT[notice])}` +
    `${after === undefined ? "" : ` ${after}`}</p>`
  );
}

/**
 * „Oczekuje na potwierdzenie” with the „Anuluj zmianę” form (D-031): its own
 * form, so on the settings page it stands outside the profile form. Once
 * the link expired (`expired`), it says so and how to get a new one: the
 * address saved again in the form sends a new link (within the daily limit).
 */
function pendingEmailNote(pendingEmail: string, expired: boolean, csrfField: string): string[] {
  const address = `<strong>${escapeHtml(pendingEmail)}</strong>`;
  return [
    expired
      ? `<p class="note">Link potwierdzający dla adresu ${address} wygasł, więc adres nie ` +
        "został zmieniony: wiadomości przychodzą na dotychczasowy adres. Aby dostać nowy " +
        "link, wpisz ten adres ponownie w ustawieniach profilu i zapisz; możesz też anulować " +
        "zmianę.</p>"
      : `<p class="note">Oczekuje na potwierdzenie: ${address}. ` +
        "Link potwierdzający wysłaliśmy na ten adres; do potwierdzenia wiadomości przychodzą " +
        "na dotychczasowy adres.</p>",
    form("/profil/anuluj-email", [csrfField], "Anuluj zmianę"),
  ];
}

/** GET /profil: the signed-in profile only; every form carries the CSRF token. */
export function profilePage(
  profile: ProfileView,
  csrfToken: string,
  notice: Notice | null = null,
): Page {
  const csrf = hidden("csrf", csrfToken);
  const pending = profile.pendingEmail ?? null;
  return {
    status: 200,
    html: layout("Twój profil", [
      ...(notice === null ? [] : [noticeParagraph(notice)]),
      `<p>Firma: <strong>${escapeHtml(profile.name)}</strong></p>`,
      // Always the current address, so a mistyped change is visible at once.
      `<p>Adres powiadomień: <strong>${escapeHtml(profile.email)}</strong></p>`,
      ...(pending === null
        ? []
        : pendingEmailNote(pending, profile.pendingEmailExpired ?? false, csrf)),
      `<p>Powiadomienia: <span class="status">${
        profile.active ? "włączone" : "wyłączone"
      }</span></p>`,
      "<ul>",
      `<li>${link("/dopasowania", "Pasujące zamówienia")} — co dziś pasuje do profilu</li>`,
      `<li>${link("/profil/ustawienia", "Ustawienia profilu")} — kategorie, regiony, ` +
        "słowa kluczowe, adres e-mail</li>",
      "</ul>",
      ...(profile.active
        ? [
            paragraph("Możesz wyłączyć codzienne powiadomienia e-mail dla tego profilu."),
            form("/profil/wypisz", [csrf], "Wypisz z powiadomień"),
          ]
        : [form("/profil/wlacz", [csrf], "Włącz ponownie powiadomienia")]),
      form("/wyloguj", [csrf], "Wyloguj"),
    ]),
  };
}

/** Element ids of the form controls; the error summary links to them. */
const FIELD_IDS: Readonly<Record<ProfileFormField, string>> = {
  name: "nazwa",
  email: "email",
  categories: "kategoria-1",
  // The group starts with the region radio (PR-13); its messages are about the choice.
  voivodeships: "region-polska",
  includeKeywords: "slowa",
  excludeKeywords: "wykluczenia",
};

/** `id`, `aria-describedby` and `aria-invalid` of a control (hint and error ids). */
function describedBy(ids: readonly string[], invalid: boolean): string {
  return (
    (ids.length === 0 ? "" : ` aria-describedby="${escapeHtml(ids.join(" "))}"`) +
    (invalid ? ' aria-invalid="true"' : "")
  );
}

function hint(id: string, text: string): string {
  return `<p class="hint" id="${escapeHtml(id)}">${escapeHtml(text)}</p>`;
}

function fieldErrors(id: string, messages: readonly string[] | undefined): string {
  if (messages === undefined) return "";
  return (
    `<p class="error" id="${escapeHtml(id)}">` +
    messages.map((message) => `<span>Błąd: ${escapeHtml(message)}</span>`).join("<br>") +
    "</p>"
  );
}

interface TextControl {
  readonly field: ProfileFormField;
  readonly hint?: string;
  readonly input: (attributes: string) => string;
}

/** A label, an optional hint, the field's errors and the control tied to them. */
function textControl(control: TextControl, errors: ProfileFormErrors): string {
  const id = FIELD_IDS[control.field];
  const messages = errors[control.field];
  const hintId = control.hint === undefined ? null : `${id}-opis`;
  const errorId = messages === undefined ? null : `${id}-blad`;
  const ids = [hintId, errorId].filter((value): value is string => value !== null);
  return (
    `<div class="field"><label for="${escapeHtml(id)}">${escapeHtml(FIELD_LABELS[control.field])}</label>` +
    (hintId === null || control.hint === undefined ? "" : hint(hintId, control.hint)) +
    (errorId === null ? "" : fieldErrors(errorId, messages)) +
    control.input(` id="${escapeHtml(id)}"${describedBy(ids, messages !== undefined)}`) +
    "</div>"
  );
}

function textInput(type: "text" | "email", name: string, value: string, extra: string) {
  return (attributes: string): string =>
    `<input type="${type}" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${extra}${attributes}>`;
}

function textarea(name: string, value: string) {
  // A leading newline right after <textarea> is dropped by the parser: one is
  // added, so a value starting with a blank line keeps it.
  return (attributes: string): string =>
    `<textarea name="${escapeHtml(name)}" rows="2"${attributes}>\n${escapeHtml(value)}</textarea>`;
}

/** One checkbox or radio with its label (the label is the ≥ 44 px touch target). */
function option(
  type: "checkbox" | "radio",
  id: string,
  name: string,
  value: string,
  label: string,
  checked: boolean,
  extra: string,
): string {
  return (
    `<div class="option"><input type="${type}" id="${escapeHtml(id)}" name="${escapeHtml(name)}" ` +
    `value="${escapeHtml(value)}"${checked ? " checked" : ""}${extra}>` +
    `<label for="${escapeHtml(id)}">${escapeHtml(label)}</label></div>`
  );
}

/** The checkboxes of a group in the grid: ids `<prefix>-1`, `<prefix>-2`, … */
function checkboxes(
  prefix: string,
  name: string,
  options: readonly (readonly [string, string])[],
  checked: readonly string[],
  invalid: boolean,
): string {
  const extra = invalid ? ' aria-invalid="true"' : "";
  const boxes = options.map(([value, label], index) =>
    option(
      "checkbox",
      `${prefix}-${String(index + 1)}`,
      name,
      value,
      label,
      checked.includes(value),
      extra,
    ),
  );
  return `<div class="options">${boxes.join("")}</div>`;
}

/**
 * A fieldset with a legend and an optional hint, then the group's errors and
 * its controls; the fieldset is described by the hint, `noteId` (a note in
 * `content`) and the errors.
 */
function group(
  field: "categories" | "voivodeships",
  prefix: string,
  hintText: string | null,
  content: string,
  errors: ProfileFormErrors,
  noteId: string | null = null,
): string {
  const messages = errors[field];
  const hintId = hintText === null ? null : `${prefix}-opis`;
  const errorId = messages === undefined ? null : `${prefix}-blad`;
  const ids = [hintId, noteId, errorId].filter((id): id is string => id !== null);
  return (
    `<fieldset${describedBy(ids, false)}><legend>${escapeHtml(FIELD_LABELS[field])}</legend>` +
    (hintId === null || hintText === null ? "" : hint(hintId, hintText)) +
    (errorId === null ? "" : fieldErrors(errorId, messages)) +
    content +
    "</fieldset>"
  );
}

/** The id of the stored-counties note, which describes the region fieldset (PR-13). */
const COUNTIES_NOTE_ID = "powiaty-uwaga";

/**
 * The region (PR-13): an explicit „Cała Polska” / „Wybrane województwa”
 * radio, then the voivodeships. No script: a contradicting choice is refused
 * by the server (validateProfileForm), never guessed. `counties`: set by the
 * operator, shown read-only — they change what „Cała Polska” matches — with
 * the way to the operator (`contactEmail`, CONTACT_EMAIL, when set).
 */
function regionGroup(
  values: ProfileFormValues,
  counties: readonly string[],
  errors: ProfileFormErrors,
  contactEmail: string | null,
): string {
  const invalid = errors.voivodeships !== undefined;
  const extra = ` required${invalid ? ' aria-invalid="true"' : ""}`;
  const radios =
    '<div class="options region">' +
    option(
      "radio",
      "region-polska",
      "region",
      REGION_ALL,
      "Cała Polska",
      values.region === REGION_ALL,
      extra,
    ) +
    option(
      "radio",
      "region-wybrane",
      "region",
      REGION_SELECTED,
      "Wybrane województwa",
      values.region === REGION_SELECTED,
      extra,
    ) +
    "</div>";
  const who =
    contactEmail === null
      ? "Powiaty zmienia obsługa — odpowiedz na ostatnią wiadomość od nas."
      : `Powiaty zmienia obsługa. ${SUPPORT_MAIL_TEXT}: ${mailLink(contactEmail)}.`;
  const countiesNote =
    counties.length === 0
      ? ""
      : `<p class="note" id="${COUNTIES_NOTE_ID}">Obsługa serwisu ustawiła w profilu powiaty: ` +
        `${escapeHtml(counties.join(", "))}. Ogłoszenia nie podają jeszcze powiatu, więc przy ` +
        "„Cała Polska” pokazujemy tylko zamówienia pasujące jednocześnie kategorią i słowem " +
        `kluczowym. ${who}</p>`;
  // No hint: the two radio labels say it (PR-13, a shorter form). The note describes the group.
  return group(
    "voivodeships",
    "wojewodztwo",
    null,
    countiesNote +
      radios +
      checkboxes(
        "wojewodztwo",
        "voivodeships",
        VOIVODESHIPS.map((voivodeship) => [voivodeship, voivodeship] as const),
        values.voivodeships,
        invalid,
      ),
    errors,
    counties.length === 0 ? null : COUNTIES_NOTE_ID,
  );
}

/** The list of all errors at the top, each linking to its field. */
function errorSummary(errors: ProfileFormErrors): string[] {
  const items = FIELD_ORDER.flatMap((field) =>
    (errors[field] ?? []).map(
      (message) =>
        `<li><a href="#${FIELD_IDS[field]}">${escapeHtml(`${FIELD_LABELS[field]}: ${message}`)}</a></li>`,
    ),
  );
  if (items.length === 0) return [];
  return [
    '<div class="error-summary" role="alert" aria-labelledby="bledy-tytul">',
    '<h2 id="bledy-tytul">Popraw błędy w formularzu</h2>',
    `<ul>${items.join("")}</ul>`,
    "</div>",
  ];
}

/**
 * GET /profil/ustawienia (200) and an invalid POST (400, the submitted
 * values shown again, escaped). Nothing is saved until every field is valid.
 * `pendingEmail`: a new address waiting for its confirmation (D-031);
 * `pendingEmailExpired`: its link expired or was revoked; `counties`: the
 * stored counties, set by the operator only (PR-13), shown read-only;
 * `contactEmail`: CONTACT_EMAIL, named next to them when set.
 */
export function settingsPage(
  values: ProfileFormValues,
  csrfToken: string,
  errors: ProfileFormErrors = {},
  pendingEmail: string | null = null,
  pendingEmailExpired = false,
  counties: readonly string[] = [],
  contactEmail: string | null = null,
): Page {
  const invalid = FIELD_ORDER.some((field) => errors[field] !== undefined);
  const fields = [
    hidden("csrf", csrfToken),
    textControl(
      {
        field: "name",
        hint: "Pokazujemy ją w wiadomościach.",
        input: textInput(
          "text",
          "name",
          values.name,
          ' maxlength="200" required autocomplete="organization"',
        ),
      },
      errors,
    ),
    textControl(
      {
        field: "email",
        hint: "Nowy adres zadziała po potwierdzeniu linkiem.",
        input: textInput(
          "email",
          "email",
          values.email,
          ' maxlength="254" required autocomplete="email"',
        ),
      },
      errors,
    ),
    group(
      "categories",
      "kategoria",
      "Co najmniej jedna. Dobieramy po kodach CPV.",
      checkboxes(
        "kategoria",
        "categories",
        MVP_CATEGORIES.map((category) => [category, CATEGORY_LABELS[category]] as const),
        values.categories,
        errors.categories !== undefined,
      ),
      errors,
    ),
    regionGroup(values, counties, errors, contactEmail),
    textControl(
      {
        field: "includeKeywords",
        hint: "Jedno w wierszu. Szukamy w tytule i opisie.",
        input: textarea("include_keywords", values.includeKeywords),
      },
      errors,
    ),
    textControl(
      {
        field: "excludeKeywords",
        hint: "Pomijamy zamówienia z tymi słowami.",
        input: textarea("exclude_keywords", values.excludeKeywords),
      },
      errors,
    ),
  ];
  return {
    status: invalid ? 400 : 200,
    html: layout(invalid ? "Błąd: Ustawienia profilu" : "Ustawienia profilu", [
      ...errorSummary(errors),
      ...(pendingEmail === null
        ? []
        : pendingEmailNote(pendingEmail, pendingEmailExpired, hidden("csrf", csrfToken))),
      form("/profil/ustawienia", fields, "Zapisz", "primary"),
      `<nav><p>${link("/profil", "Wróć do profilu bez zapisywania")}</p></nav>`,
    ]),
  };
}

/**
 * The URL of a /dopasowania page or of its CSV (PR-13): page 1 has no
 * parameter (the canonical form), the others `?strona=N`. Built from the
 * parsed number only, never from the request's text.
 */
export function matchesHref(page: number, kind: "page" | "csv" = "page"): string {
  const path = kind === "page" ? "/dopasowania" : "/dopasowania.csv";
  return page <= 1 ? path : `${path}?strona=${String(page)}`;
}

/** Which page of the list /dopasowania shows (PR-13). */
export interface MatchesPagination {
  /** 1-based, at most `pages`. */
  readonly page: number;
  /** At least 1 (an empty list is one empty page). */
  readonly pages: number;
  /** The index of the page's first offer in the whole list (0-based). */
  readonly offset: number;
  /** Offers on all pages together (at most `limit`). */
  readonly listed: number;
  /** Most offers on all pages (the page limit × offers per page). */
  readonly limit: number;
}

export interface MatchesView {
  readonly active: boolean;
  /** The profile names voivodeships (none: the whole country). */
  readonly hasVoivodeships: boolean;
  /** The profile names counties (no source gives an offer's county yet). */
  readonly hasCounties: boolean;
  /** The time the list was made, already formatted (Polish time). */
  readonly stateAt: string;
  /** How many days back "new" goes (DIGEST_NEW_DAYS). */
  readonly windowDays: number;
  /** This page's cards: soonest deadline first, those rated „Nietrafne” last (whole list). */
  readonly items: readonly MatchesItem[];
  readonly pagination: MatchesPagination;
  /** Matching offers beyond the page limit (on no page). */
  readonly more: number;
  /** The candidate limit was reached: some offers were not considered. */
  readonly truncated: boolean;
}

/** The rating form of one card on /dopasowania (PR-12, D-032). */
export interface CardFeedback {
  readonly opportunityId: string;
  /** The profile's current rating; null: not rated. */
  readonly verdict: FeedbackVerdict | null;
  /** The session's CSRF token. */
  readonly csrf: string;
  /**
   * The id of the card shown after this one (null: the last): where the page
   * returns after „Nietrafne”, which moves this card to the end (`nastepna`).
   */
  readonly next: string | null;
  /**
   * The list page the card is on (PR-13): the rating returns there
   * (`strona`). Absent or 1: no field, page 1.
   */
  readonly page?: number;
}

/** A card of /dopasowania: with the rating buttons when `feedback` is given. */
export type MatchesItem = OfferCard & { readonly feedback?: CardFeedback };

/**
 * „Trafne” / „Nietrafne” under a card: one POST form (session and CSRF) with
 * two submit buttons; each button's accessible name says which offer it rates.
 * Once rated, both are toggle buttons: the current verdict's is pressed (and bold).
 */
function feedbackForm(title: string, feedback: CardFeedback): string {
  const current =
    feedback.verdict === null
      ? "Czy to zamówienie pasuje?"
      : `Twoja ocena: <strong>${verdictWord(feedback.verdict)}</strong>. Możesz ją zmienić.`;
  const button = (verdict: FeedbackVerdict, label: string): string => {
    const pressed = feedback.verdict === null ? "" : String(feedback.verdict === verdict);
    return (
      `<button type="submit" name="werdykt" value="${verdictWord(verdict)}" ` +
      `aria-label="${escapeHtml(`${label}: ${title}`)}"` +
      (pressed === "" ? "" : ` aria-pressed="${pressed}"`) +
      `>${pressed === "true" ? `<strong>${label}</strong>` : label}</button>`
    );
  };
  return (
    '<form method="post" action="/dopasowania/ocena" class="ocena">' +
    `<p>${current}</p>` +
    hidden("csrf", feedback.csrf) +
    hidden("oferta", feedback.opportunityId) +
    (feedback.next === null ? "" : hidden("nastepna", feedback.next)) +
    (feedback.page === undefined || feedback.page <= 1
      ? ""
      : hidden("strona", String(feedback.page))) +
    button("relevant", RATE_RELEVANT_LABEL) +
    button("not_relevant", RATE_NOT_RELEVANT_LABEL) +
    "</form>"
  );
}

/** One row in the card's grid; `more` ends its value (the full description). */
function cardRow(row: CardRow, more = ""): string {
  const urgent = row.urgent ? `<strong class="pilne">${URGENT_WORD}</strong> ` : "";
  return `<dt>${escapeHtml(row.label)}:</dt><dd>${urgent}${escapeHtml(row.value)}${more}</dd>`;
}

/**
 * One offer card (src/notifications/card.ts, the digest's content): the rows
 * in a grid, the full description under the excerpt when it was cut, one
 * "Otwórz ogłoszenie" button and the match details, both disclosures native
 * <details> (no script).
 */
function cardItem(card: MatchesItem): string {
  const full =
    card.fullDescription === null
      ? ""
      : `<details><summary>${FULL_DESCRIPTION_LABEL}</summary>` +
        `<p>${escapeHtml(card.fullDescription)}</p></details>`;
  const rows = card.rows.map((row) => cardRow(row, row.label === DESCRIPTION_LABEL ? full : ""));
  // Only an http(s) URL (offerCard checked it); a new tab must not reach back to this page.
  const button =
    card.url === null
      ? ""
      : `<p><a class="button" href="${escapeHtml(card.url)}" rel="noopener noreferrer">` +
        `${OPEN_LABEL}</a></p>`;
  const details =
    card.matchDetails.length === 0
      ? ""
      : `<details><summary>${MATCH_DETAILS_LABEL}</summary><ul>` +
        `${card.matchDetails.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`;
  const { feedback } = card;
  if (feedback === undefined) {
    return (
      `<li><article><h2>${escapeHtml(card.title)}</h2><dl>${rows.join("")}</dl>` +
      `${button}${details}</article></li>`
    );
  }
  // An anchor for the redirect after rating; a „Nietrafne” card is greyed (and listed last).
  const greyed = feedback.verdict === "not_relevant" ? ' class="nietrafne"' : "";
  return (
    `<li id="oferta-${escapeHtml(feedback.opportunityId)}"><article${greyed}>` +
    `<h2>${escapeHtml(card.title)}</h2><dl>${rows.join("")}</dl>` +
    `${button}${details}${feedbackForm(card.title, feedback)}</article></li>`
  );
}

/**
 * Under a list of more than one page (PR-13): „Strona X z Y” on its own
 * line, then „← Poprzednia” / „Następna →”, each a ≥ 44 px touch target. The
 * only links with `rel` (the line above the list has a plain one).
 */
function pager(pagination: MatchesPagination): string {
  const { page, pages } = pagination;
  const links = [
    ...(page > 1
      ? [`<a href="${escapeHtml(matchesHref(page - 1))}" rel="prev">← Poprzednia strona</a>`]
      : []),
    ...(page < pages
      ? [`<a href="${escapeHtml(matchesHref(page + 1))}" rel="next">${NEXT_PAGE_LABEL} →</a>`]
      : []),
  ];
  return (
    '<nav aria-label="Strony listy">' +
    `<p class="pages-status">Strona ${String(page)} z ${String(pages)}</p>` +
    `<p class="pages">${links.join("")}</p></nav>`
  );
}

const NEXT_PAGE_LABEL = "Następna strona";

/**
 * GET /dopasowania: the offers matching the profile now, by the digest's
 * candidates and rules (D-027), shown the way the digest shows them; a page
 * of MATCHES_SHOWN at a time (PR-13).
 */
export function matchesPage(view: MatchesView): Page {
  const { page, pages, offset, listed, limit } = view.pagination;
  const days = `${String(view.windowDays)} dni`;
  const window =
    `Pokazujemy zamówienia dodane do Radaru w ciągu ostatnich ${days}, których termin ` +
    "składania ofert jeszcze nie minął.";
  const body: string[] = [];
  if (!view.active) {
    body.push(
      '<p class="note">Powiadomienia e-mail są wyłączone: tej listy nie wysyłamy. ' +
        `Włączysz je na stronie ${link("/profil", "Twój profil")}.</p>`,
    );
  }
  if (view.items.length === 0) {
    // No voivodeship ticked already means the whole country: adding one narrows.
    const widen = view.hasVoivodeships
      ? "dodaj kategorie, słowa kluczowe lub województwa (albo wybierz „Cała Polska”)"
      : "dodaj kategorie lub słowa kluczowe";
    body.push(
      paragraph(`Brak pasujących zamówień. ${window}`),
      `<p>Jeśli lista często jest pusta, rozszerz profil w ${link(
        "/profil/ustawienia",
        "ustawieniach",
      )}: ${escapeHtml(widen)} albo usuń część słów wykluczających.</p>`,
      ...(view.hasCounties
        ? [
            paragraph(
              view.hasVoivodeships
                ? COUNTIES_NOTE.withVoivodeships
                : COUNTIES_NOTE.withoutVoivodeships,
            ),
          ]
        : []),
    );
  } else {
    const first = offset + 1;
    const last = offset + view.items.length;
    const range = `${String(first)}–${String(last)}`;
    body.push(
      ...(pages > 1
        ? [
            `<p><strong>Strona ${String(page)} z ${String(pages)}</strong>: zamówienia ${range} ` +
              `z ${String(listed + view.more)}.` +
              (page < pages ? ` ${link(matchesHref(page + 1), `${NEXT_PAGE_LABEL} →`)}` : "") +
              "</p>",
          ]
        : []),
      paragraph(`${window} Najbliższy termin na górze. Stan na ${view.stateAt} (czas polski).`),
      paragraph("Lista obejmuje także zamówienia, które już wysłaliśmy e-mailem."),
      paragraph(
        "Oceń zamówienia przyciskami „Trafne” i „Nietrafne” — pomagasz nam lepiej je dobierać. " +
          "Ocenione jako nietrafne są wyszarzone i na końcu listy.",
      ),
      // The CSV is the page shown (the same rows): one file per page.
      pages > 1
        ? `<p>${link(matchesHref(page, "csv"), "Pobierz tę stronę jako plik CSV")} ` +
            `(zamówienia ${range}; Excel, Arkusze Google). Plik obejmuje tylko tę stronę — ` +
            "pozostałe pobierzesz z ich stron (linki stron pod listą).</p>"
        : `<p>${link(matchesHref(1, "csv"), "Pobierz listę jako plik CSV")} ` +
            "(Excel, Arkusze Google).</p>",
      `<ol class="matches"${offset > 0 ? ` start="${String(first)}"` : ""}>` +
        `${view.items.map(cardItem).join("")}</ol>`,
    );
    // Offers beyond the page limit are on no page: said once, after the last one.
    if (view.more > 0 && page === pages) {
      // Genitive after the negation: „nie pokazujemy 1 kolejnego … / 3 kolejnych …”.
      const offers = plural(
        view.more,
        "pasującego zamówienia",
        "pasujących zamówień",
        "pasujących zamówień",
      );
      body.push(
        paragraph(
          `Lista kończy się na ${String(limit)} zamówieniach. Nie pokazujemy ${String(view.more)} ` +
            `${plural(view.more, "kolejnego", "kolejnych", "kolejnych")} ` +
            `${offers} z dalszym terminem lub ` +
            `${plural(view.more, "ocenionego", "ocenionych", "ocenionych")} jako nietrafne. ` +
            "Aby lista była krótsza, zawęź profil, np. słowami wykluczającymi.",
        ),
      );
    }
    if (pages > 1) body.push(pager(view.pagination));
    body.push(
      paragraph(
        "Dane pochodzą z publicznych ogłoszeń. Termin mógł się zmienić, a postępowanie mogło " +
          "zostać odwołane — przed złożeniem oferty sprawdź ogłoszenie w źródle.",
      ),
    );
  }
  if (view.truncated) {
    body.push(
      '<p class="note">Lista może być niepełna: nowych zamówień jest dziś więcej, niż ' +
        "sprawdzamy naraz.</p>",
    );
  }
  body.push(
    `<nav><p>${link("/profil", "Twój profil")} · ${link("/profil/ustawienia", "Ustawienia profilu")}</p></nav>`,
  );
  return { status: 200, html: layout("Pasujące zamówienia", body) };
}

/** The sample of GET /przyklad: a made-up profile and its matched offers (src/web/example.ts). */
export interface ExampleView {
  readonly name: string;
  /** The profile's rules in one line. */
  readonly summary: string;
  readonly items: readonly OfferCard[];
}

/**
 * GET /przyklad (PR-10): a sample digest in the cards of /dopasowania,
 * public and the same for everyone (constant data, no database).
 */
export function examplePage(view: ExampleView): Page {
  return {
    status: 200,
    html: layout("Przykładowe zestawienie", [
      paragraph(
        "Tak wygląda zestawienie zamówień dobranych do profilu firmy. Firma, zamawiający " +
          "i ogłoszenia poniżej są zmyślone.",
      ),
      `<p>Profil: <strong>${escapeHtml(view.name)}</strong> — ${escapeHtml(view.summary)}</p>`,
      `<ol class="matches">${view.items.map(cardItem).join("")}</ol>`,
      paragraph(
        "Codzienna wiadomość e-mail pokazuje zamówienia tak samo, a strona profilu " +
          "„Pasujące zamówienia” — wszystkie aktualnie pasujące.",
      ),
      homeLink(),
    ]),
  };
}

/** The sentence before CONTACT_EMAIL wherever only the operator can help (PR-13). */
const SUPPORT_MAIL_TEXT = "Napisz do obsługi serwisu";

/**
 * Where to turn when only the operator can correct the stored profile
 * (PR-13): CONTACT_EMAIL when set, else a reply to our last e-mail.
 */
function supportContact(contactEmail: string | null): string {
  return contactEmail === null
    ? paragraph("Odpowiedz na ostatnią wiadomość od nas — obsługa serwisu poprawi profil.")
    : `<p>${SUPPORT_MAIL_TEXT}: ${mailLink(contactEmail)}.</p>`;
}

/** What only the operator can correct, in the customer's words (PR-13). */
const OPERATOR_SETTING_TEXT =
  "Profil zawiera ustawienie, które może poprawić tylko obsługa serwisu (na przykład powiaty)";

/**
 * /dopasowania for a stored profile the schema refuses: it must be corrected
 * first. `correctable` (correctableInForm): in the settings form; otherwise
 * (PR-13: e.g. counties, set by the operator only) by the operator, reached
 * at `contactEmail` (CONTACT_EMAIL) when set.
 */
export function matchesUnavailablePage(
  correctable = true,
  contactEmail: string | null = null,
): Page {
  return {
    status: 200,
    html: layout("Pasujące zamówienia", [
      paragraph(
        "Zapisany profil jest niekompletny albo zawiera niedozwolone wartości, więc nie możemy " +
          "dobrać do niego zamówień.",
      ),
      correctable
        ? `<p>Popraw go w ${link("/profil/ustawienia", "ustawieniach profilu")}.</p>`
        : paragraph(`${OPERATOR_SETTING_TEXT}.`) + supportContact(contactEmail),
      backLinks(),
    ]),
  };
}

/**
 * 409 on POST /profil/ustawienia (PR-13): the form was valid, but the stored
 * profile keeps a value the form does not rewrite (operator-set counties)
 * that the schema refuses — nothing was saved. Not a 500: the request is
 * fine and a retry fails the same way until the operator corrects the row.
 */
export function profileSaveBlockedPage(contactEmail: string | null = null): Page {
  return {
    status: 409,
    html: layout("Nie zapisano zmian", [
      paragraph(
        `${OPERATOR_SETTING_TEXT}. Dopóki go nie poprawi, zmian w formularzu nie da się zapisać.`,
      ),
      supportContact(contactEmail),
      backLinks(),
    ]),
  };
}

/** Seconds before the 503 page of /dopasowania reloads itself (PR-13). */
export const MATCHES_REFRESH_SECONDS = 3;

/**
 * 503 on /dopasowania while this server computes another list (one at a
 * time, D-027): a waiting page that reloads the same URL (`href`, the same
 * page or CSV, built by matchesHref) on its own after
 * MATCHES_REFRESH_SECONDS — a meta refresh, no script (PR-13). `kind`: what
 * `href` is — for the CSV the text speaks of the file (the reload downloads
 * it).
 */
export function matchesBusyPage(href: string, kind: "page" | "csv" = "page"): Page {
  const [text, action] =
    kind === "page"
      ? ["Liczymy listę… strona odświeży się sama za kilka sekund.", "Odśwież teraz"]
      : ["Przygotowujemy plik… pobierze się sam za kilka sekund.", "Pobierz teraz"];
  return {
    status: 503,
    html: layout(
      "Pasujące zamówienia",
      [paragraph(text), `<p>${link(href, action)}</p>`, backLinks()],
      [
        `<meta http-equiv="refresh" content="${String(MATCHES_REFRESH_SECONDS)}; url=${escapeHtml(href)}">`,
      ],
    ),
  };
}

/**
 * 429: this session already has MATCHES_MAX_PER_SESSION /dopasowania
 * requests in progress — in plain words, with the way back to `href`
 * (matchesHref). No refresh: the other tab is the one computing.
 */
export function matchesTooManyPage(href: string): Page {
  return {
    status: 429,
    html: layout("Pasujące zamówienia", [
      paragraph(
        "Ta lista już się przygotowuje (np. w innej karcie albo po odświeżeniu). Poczekaj " +
          "chwilę i otwórz ją ponownie.",
      ),
      `<p>${link(href, "Otwórz listę ponownie")}</p>`,
      backLinks(),
    ]),
  };
}

/** What the page of a valid rating link shows (PR-12, D-032). */
export interface FeedbackConfirmView {
  readonly title: string;
  /** The link's verdict. */
  readonly verdict: FeedbackVerdict;
  /** The profile's current rating of the offer; null: not rated. */
  readonly current: FeedbackVerdict | null;
  /** The link's own path (the form's action). */
  readonly path: string;
  /** The same link with the other verdict. */
  readonly oppositePath: string;
}

/**
 * GET /ocena/<token>/<offer>/<verdict> (PR-12, D-032): read-only (a mail
 * scanner may open it); only the POST of the button stores the rating. When
 * the offer already has the link's verdict, the only button is the other
 * verdict's. Only for a valid link: every refused one is invalidLinkPage.
 */
export function feedbackConfirmPage(view: FeedbackConfirmView): Page {
  const word = verdictWord(view.verdict);
  const opposite = verdictWord(view.verdict === "relevant" ? "not_relevant" : "relevant");
  const choice =
    view.current === view.verdict
      ? [
          paragraph(`To zamówienie ma już ocenę: ${word}.`),
          form(view.oppositePath, [], `Zmień ocenę na: ${opposite}`),
        ]
      : [
          ...(view.current === null
            ? []
            : [paragraph(`Obecna ocena: ${verdictWord(view.current)}.`)]),
          paragraph(`Kliknij przycisk, aby ocenić to zamówienie jako ${word}.`),
          form(view.path, [], `Zapisz ocenę: ${word}`),
        ];
  return {
    status: 200,
    html: layout("Ocena zamówienia", [
      `<p>Zamówienie: <strong>${escapeHtml(view.title)}</strong></p>`,
      ...choice,
      paragraph(
        "Oceny pomagają nam lepiej dobierać zamówienia. Ocenę możesz zmienić drugim linkiem " +
          "z wiadomości albo na stronie „Pasujące zamówienia” w profilu.",
      ),
    ]),
  };
}

/** After the POST of a rating link: saved (or unchanged when it was the same). */
export function feedbackSavedPage(verdict: FeedbackVerdict): Page {
  return {
    status: 200,
    html: layout("Dziękujemy za ocenę", [
      paragraph(`Zapisaliśmy ocenę: ${verdictWord(verdict)}.`),
      paragraph(
        "Ocenę możesz zmienić drugim linkiem z wiadomości albo na stronie „Pasujące " +
          "zamówienia” w profilu.",
      ),
      paragraph("Możesz zamknąć tę kartę i wrócić do wiadomości."),
      `<nav><p>${link("/dopasowania", "Pasujące zamówienia")} · ${link("/", "Strona główna")}</p></nav>`,
    ]),
  };
}

/** GET /wypis/<token>: confirms; only the POST (the RFC 8058 body) unsubscribes. */
export function unsubscribeConfirmPage(token: string, profileName: string): Page {
  return {
    status: 200,
    html: layout("Wypisanie z powiadomień", [
      `<p>Firma: <strong>${escapeHtml(profileName)}</strong></p>`,
      paragraph("Kliknij przycisk, aby wyłączyć codzienne powiadomienia e-mail dla tej firmy."),
      form(`/wypis/${token}`, [hidden("List-Unsubscribe", "One-Click")], "Wypisz mnie"),
    ]),
  };
}

export function unsubscribedPage(): Page {
  return {
    status: 200,
    html: layout("Wypisano", [
      paragraph("Powiadomienia e-mail zostały wyłączone. Nie wyślemy kolejnych wiadomości."),
      paragraph(RESUBSCRIBE_HINT),
    ]),
  };
}

export type ErrorStatus = 400 | 403 | 404 | 405 | 413 | 415 | 500;

const ERROR_TEXT: Readonly<Record<ErrorStatus, readonly [string, string]>> = {
  400: ["Nieprawidłowe żądanie", "Formularz zawiera nieprawidłowe dane."],
  403: ["Brak dostępu", "Nie można wykonać tej operacji. Odśwież stronę i spróbuj ponownie."],
  404: ["Nie znaleziono", "Ta strona nie istnieje."],
  405: ["Niedozwolona metoda", "Ta strona nie obsługuje tego rodzaju żądania."],
  413: ["Za duże żądanie", "Przesłane dane są za duże."],
  415: ["Nieobsługiwany format", "Ten format danych nie jest obsługiwany."],
  500: ["Błąd serwera", "Wystąpił błąd. Spróbuj ponownie później."],
};

/** 403 on POST /dostep when the request cannot be shown to come from our own page. */
export function loginRefusedPage(): Page {
  return {
    status: 403,
    html: layout("Brak dostępu", [
      paragraph(
        "Nie można wykonać tej operacji. Odśwież stronę i spróbuj ponownie albo otwórz link " +
          "w innej, aktualnej przeglądarce.",
      ),
      homeLink(),
    ]),
  };
}

export function errorPage(status: ErrorStatus): Page {
  const [title, text] = ERROR_TEXT[status];
  return { status, html: layout(title, [paragraph(text), backLinks()]) };
}

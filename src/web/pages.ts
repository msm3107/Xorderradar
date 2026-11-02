import { VOIVODESHIPS, MVP_CATEGORIES } from "../domain/vocabulary.js";
import { escapeHtml } from "../infrastructure/html.js";
import { plural, type DigestField, type DigestItemView } from "../notifications/digest.js";
import {
  CATEGORY_LABELS,
  FIELD_LABELS,
  FIELD_ORDER,
  type ProfileFormErrors,
  type ProfileFormField,
  type ProfileFormValues,
} from "./profile-form.js";
import type { Notice } from "./session.js";

/**
 * The HTML pages of the web access (PR-06A, PR-06B). Polish, server-rendered, no
 * script and no inline style (the CSP forbids both): every value is escaped
 * with the shared escapeHtml. Forms are plain POST forms with labelled real
 * buttons. A page never shows a token except inside the hidden field of the
 * form that submits it.
 */

export interface Page {
  readonly status: number;
  readonly html: string;
}

/** The one stylesheet, served as /styl.css. */
export const STYLESHEET = `body{font-family:system-ui,sans-serif;line-height:1.5;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.4rem}
form{margin:1rem 0}
button{font:inherit;padding:.5rem 1rem;cursor:pointer}
.status{font-weight:bold}
.notice{border-left:.3rem solid #1a7f37;padding:.5rem 1rem;background:#f0f7f1}
.note{border-left:.3rem solid #8a6d00;padding:.5rem 1rem;background:#fbf6e6}
.error-summary{border:.2rem solid #b00020;padding:.5rem 1rem;margin:1rem 0}
.error-summary h2{font-size:1.1rem;margin:.3rem 0}
.error{color:#b00020;font-weight:bold;margin:.3rem 0}
.hint{color:#555;margin:.3rem 0}
.field{margin:1.2rem 0}
fieldset{border:1px solid #ccc;margin:1.2rem 0;padding:.5rem 1rem}
legend{font-weight:bold;padding:0 .3rem}
label{display:block;font-weight:bold}
.option label{display:inline;font-weight:normal;margin-left:.4rem}
input[type=text],input[type=email],textarea{box-sizing:border-box;width:100%;font:inherit;padding:.4rem}
[aria-invalid=true]{border:.15rem solid #b00020}
.matches{padding-left:1.2rem}
.matches h2{font-size:1.05rem;margin:1.5rem 0 .3rem}
dl{margin:0}
dt{font-weight:bold;float:left;clear:left;margin-right:.4rem}
dd{margin:0 0 .2rem}
.matches details{margin:.3rem 0}
.matches summary{cursor:pointer}
nav p{margin:1.5rem 0}
`;

const SITE_NAME = "Radar Zamówień";

/**
 * How a customer gets back in: the links are single-use and expire, and there is
 * no self-service re-issue (the operator runs access:link). One shared sentence,
 * so the 404 stays the same page for every token failure.
 */
const NEW_LINK_HINT =
  "Jeśli link został już użyty lub wygasł, odpowiedz na ostatnią wiadomość — operator wyśle nowy link.";

/**
 * Counties: kept in the profile, but no source gives an offer's county yet, so
 * they never narrow and never match (src/matching/match.ts, regionReason). A
 * profile with counties and no voivodeship has an unknown region for every
 * offer: only category + keyword reach MATCH_THRESHOLD then.
 */
const COUNTIES_HINT =
  "Jeden powiat w wierszu, np. warszawski zachodni. Ogłoszenia nie podają jeszcze powiatu — " +
  "zamówienia dobieramy po województwie, więc zaznacz województwo. Sam powiat bez województwa " +
  "pokaże tylko zamówienia pasujące jednocześnie kategorią i słowem kluczowym.";
/** The empty matches page's note on counties, with voivodeships ticked or not. */
const COUNTIES_NOTE = {
  withVoivodeships:
    "Wpisane powiaty nie zawężają listy: ogłoszenia nie podają jeszcze powiatu, więc liczy się " +
    "województwo. Powiat bez zaznaczonego województwa przepuszcza tylko zamówienia pasujące " +
    "jednocześnie kategorią i słowem kluczowym.",
  withoutVoivodeships:
    "Ogłoszenia nie podają jeszcze powiatu, więc same powiaty nie wystarczą: zaznacz " +
    "województwo w ustawieniach. Bez województwa pokazujemy tylko zamówienia pasujące " +
    "jednocześnie kategorią i słowem kluczowym.",
} as const;

/**
 * The way back after an unsubscribe without a session (the one-click link):
 * the operator re-enables. A signed-in customer has the button on /profil
 * instead (PR-06B).
 */
const RESUBSCRIBE_HINT =
  "Jeśli to pomyłka, odpowiedz na ostatnią wiadomość — włączymy powiadomienia ponownie.";

function layout(title: string, body: readonly string[]): string {
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
    `<title>${escapeHtml(title === SITE_NAME ? title : `${title} — ${SITE_NAME}`)}</title>`,
    '<link rel="stylesheet" href="/styl.css">',
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(title)}</h1>`,
    ...body,
    "</main>",
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

function homeLink(): string {
  return `<nav><p>${link("/", "Strona główna")}</p></nav>`;
}

/** Ways back from a page that is not the profile itself. */
function backLinks(): string {
  return `<nav><p>${link("/profil", "Twój profil")} · ${link("/", "Strona główna")}</p></nav>`;
}

function form(action: string, fields: readonly string[], button: string): string {
  return (
    `<form method="post" action="${escapeHtml(action)}">` +
    fields.join("") +
    `<button type="submit">${escapeHtml(button)}</button></form>`
  );
}

export function homePage(): Page {
  return {
    status: 200,
    html: layout(SITE_NAME, [
      paragraph(
        "Radar Zamówień wysyła raz dziennie nowe zamówienia publiczne pasujące do profilu firmy.",
      ),
      paragraph("Aby zobaczyć swój profil, użyj linku „Twój profil” z ostatniej wiadomości."),
      paragraph(NEW_LINK_HINT),
    ]),
  };
}

/** GET /dostep/<token>: confirms the login; only the POST uses the link up. */
export function loginConfirmPage(token: string): Page {
  return {
    status: 200,
    html: layout("Logowanie", [
      paragraph(
        "Kliknij przycisk, aby otworzyć swój profil. Link działa tylko raz; " +
          "logowanie jest ważne 30 dni na tym urządzeniu.",
      ),
      form("/dostep", [hidden("token", token)], "Zaloguj się"),
    ]),
  };
}

/** One page for an unknown, used and expired link alike: nothing tells them apart. */
export function invalidLinkPage(): Page {
  return {
    status: 404,
    html: layout("Link jest nieaktywny", [
      paragraph("Ten link nie działa."),
      paragraph(NEW_LINK_HINT),
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
      homeLink(),
    ]),
  };
}

export interface ProfileView {
  readonly name: string;
  /** The current notification address, read with the session's profile. */
  readonly email: string;
  readonly active: boolean;
}

/** What /profil says once after a form (session.ts, NOTICE_COOKIE). */
const NOTICE_TEXT: Readonly<Record<Notice, string>> = {
  zapisano: "Zapisano zmiany profilu.",
  zmieniono_email:
    "Zapisano zmiany profilu. Adres e-mail został zmieniony: linki z wcześniejszych wiadomości " +
    "przestały działać, a inne urządzenia zostały wylogowane. Sprawdź poniżej, czy nowy adres " +
    "jest poprawny.",
  wypisano: "Wypisano z powiadomień. Nie wyślemy kolejnych wiadomości.",
  wlaczono:
    "Włączono powiadomienia. Nowe pasujące zamówienia przyjdą w najbliższej codziennej wiadomości.",
};

/** GET /profil: the signed-in profile only; every form carries the CSRF token. */
export function profilePage(
  profile: ProfileView,
  csrfToken: string,
  notice: Notice | null = null,
): Page {
  const csrf = hidden("csrf", csrfToken);
  return {
    status: 200,
    html: layout("Twój profil", [
      ...(notice === null
        ? []
        : [`<p class="notice" role="status">${escapeHtml(NOTICE_TEXT[notice])}</p>`]),
      `<p>Firma: <strong>${escapeHtml(profile.name)}</strong></p>`,
      // Always the current address, so a mistyped change is visible at once.
      `<p>Adres powiadomień: <strong>${escapeHtml(profile.email)}</strong></p>`,
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
  emailConfirm: "email-powtorz",
  categories: "kategoria-1",
  voivodeships: "wojewodztwo-1",
  counties: "powiaty",
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
    `<textarea name="${escapeHtml(name)}" rows="5"${attributes}>\n${escapeHtml(value)}</textarea>`;
}

/** A fieldset of checkboxes with a legend, a hint and the group's errors. */
function checkboxGroup(
  field: "categories" | "voivodeships",
  name: string,
  hintText: string,
  options: readonly (readonly [string, string])[],
  checked: readonly string[],
  errors: ProfileFormErrors,
): string {
  const prefix = field === "categories" ? "kategoria" : "wojewodztwo";
  const messages = errors[field];
  const hintId = `${prefix}-opis`;
  const errorId = `${prefix}-blad`;
  const ids = messages === undefined ? [hintId] : [hintId, errorId];
  const boxes = options.map(([value, label], index) => {
    const id = `${prefix}-${String(index + 1)}`;
    return (
      `<div class="option"><input type="checkbox" id="${id}" name="${escapeHtml(name)}" ` +
      `value="${escapeHtml(value)}"${checked.includes(value) ? " checked" : ""}` +
      `${messages === undefined ? "" : ' aria-invalid="true"'}>` +
      `<label for="${id}">${escapeHtml(label)}</label></div>`
    );
  });
  return (
    `<fieldset${describedBy(ids, false)}><legend>${escapeHtml(FIELD_LABELS[field])}</legend>` +
    hint(hintId, hintText) +
    (messages === undefined ? "" : fieldErrors(errorId, messages)) +
    boxes.join("") +
    "</fieldset>"
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
 */
export function settingsPage(
  values: ProfileFormValues,
  csrfToken: string,
  errors: ProfileFormErrors = {},
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
    "<fieldset><legend>Adres e-mail do powiadomień</legend>",
    textControl(
      {
        field: "email",
        hint:
          "Na ten adres wysyłamy codzienną wiadomość. Nowego adresu nie potwierdzamy wiadomością — " +
          "sprawdź, czy jest poprawny. Po zmianie adresu linki z wcześniejszych wiadomości " +
          "przestaną działać, a inne urządzenia zostaną wylogowane.",
        input: textInput(
          "email",
          "email",
          values.email,
          ' maxlength="254" required autocomplete="email"',
        ),
      },
      errors,
    ),
    textControl(
      {
        field: "emailConfirm",
        hint: "Wypełnij tylko przy zmianie adresu.",
        input: textInput(
          "email",
          "email_confirm",
          values.emailConfirm,
          ' maxlength="254" autocomplete="off"',
        ),
      },
      errors,
    ),
    "</fieldset>",
    checkboxGroup(
      "categories",
      "categories",
      "Wybierz co najmniej jedną. Kategorię zamówienia ustalamy z jego kodów CPV.",
      MVP_CATEGORIES.map((category) => [category, CATEGORY_LABELS[category]] as const),
      values.categories,
      errors,
    ),
    checkboxGroup(
      "voivodeships",
      "voivodeships",
      "Nie zaznaczaj żadnego, jeśli interesują Cię zamówienia z całej Polski.",
      VOIVODESHIPS.map((voivodeship) => [voivodeship, voivodeship] as const),
      values.voivodeships,
      errors,
    ),
    textControl(
      {
        field: "counties",
        hint: COUNTIES_HINT,
        input: textarea("counties", values.counties),
      },
      errors,
    ),
    textControl(
      {
        field: "includeKeywords",
        hint:
          "Jedno słowo lub wyrażenie w wierszu, np. oświetlenie. Szukamy ich w tytule i opisie " +
          "zamówienia. Najwyżej 100.",
        input: textarea("include_keywords", values.includeKeywords),
      },
      errors,
    ),
    textControl(
      {
        field: "excludeKeywords",
        hint:
          "Zamówienia z którymkolwiek z tych słów pomijamy. Jedno w wierszu, np. dostawa paliwa. " +
          "Najwyżej 100.",
        input: textarea("exclude_keywords", values.excludeKeywords),
      },
      errors,
    ),
  ];
  return {
    status: invalid ? 400 : 200,
    html: layout(invalid ? "Błąd: Ustawienia profilu" : "Ustawienia profilu", [
      ...errorSummary(errors),
      paragraph("Zmiany obowiązują od najbliższej codziennej wiadomości."),
      form("/profil/ustawienia", fields, "Zapisz"),
      `<nav><p>${link("/profil", "Wróć do profilu bez zapisywania")}</p></nav>`,
    ]),
  };
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
  /** The shown offers, soonest deadline first. */
  readonly items: readonly DigestItemView[];
  /** Matching offers beyond the shown ones. */
  readonly more: number;
  /** The candidate limit was reached: some offers were not considered. */
  readonly truncated: boolean;
}

/** The source link: only an http(s) href (digestItemView checked it), named by its host. */
function sourceLink(href: string): string {
  const host = URL.parse(href)?.host ?? "";
  return (
    `<a href="${escapeHtml(href)}" rel="noopener noreferrer">Otwórz ogłoszenie w źródle` +
    `${host === "" ? "" : ` (${escapeHtml(host)})`}</a>`
  );
}

/**
 * The digest fields a match card shows at once, the place of work among them
 * (for a whole-country profile the reasons do not name it); the others
 * (publication date, category, description, contact) wait in its <details>.
 */
const CARD_LABELS: ReadonlySet<string> = new Set([
  "Zamawiający",
  "Lokalizacja",
  "Termin składania ofert",
  "Dlaczego pasuje",
  "Link",
]);

function fieldList(fields: readonly DigestField[]): string {
  const rows = fields.map(
    (field) =>
      `<dt>${escapeHtml(field.label)}:</dt><dd>${
        field.href === undefined ? escapeHtml(field.value) : sourceLink(field.href)
      }</dd>`,
  );
  return `<dl>${rows.join("")}</dl>`;
}

/** A compact card: the essentials, the rest behind a native <details> (no script). */
function matchItem(item: DigestItemView): string {
  const shown = item.fields.filter((field) => CARD_LABELS.has(field.label));
  const folded = item.fields.filter((field) => !CARD_LABELS.has(field.label));
  const details =
    folded.length === 0
      ? ""
      : `<details><summary>Szczegóły ogłoszenia</summary>${fieldList(folded)}</details>`;
  return (
    `<li><article><h2>${escapeHtml(item.title)}</h2>${fieldList(shown)}${details}` +
    "</article></li>"
  );
}

/**
 * GET /dopasowania: the offers matching the profile now, by the digest's
 * candidates and rules (D-027), shown the way the digest shows them.
 */
export function matchesPage(view: MatchesView): Page {
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
      ? "dodaj kategorie, słowa kluczowe lub województwa (albo odznacz wszystkie województwa, " +
        "aby szukać w całej Polsce)"
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
    body.push(
      paragraph(`${window} Najbliższy termin na górze. Stan na ${view.stateAt} (czas polski).`),
      paragraph("Lista obejmuje także zamówienia, które już wysłaliśmy e-mailem."),
      `<ol class="matches">${view.items.map(matchItem).join("")}</ol>`,
    );
    if (view.more > 0) {
      const offers = plural(
        view.more,
        "pasujące zamówienie",
        "pasujące zamówienia",
        "pasujących zamówień",
      );
      body.push(
        paragraph(
          `I ${String(view.more)} ${plural(view.more, "kolejne", "kolejne", "kolejnych")} ` +
            `${offers} z dalszym terminem. Aby lista była krótsza, zawęź profil, np. słowami ` +
            "wykluczającymi.",
        ),
      );
    }
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

/** /dopasowania for a stored profile the schema refuses: it must be corrected first. */
export function matchesUnavailablePage(): Page {
  return {
    status: 200,
    html: layout("Pasujące zamówienia", [
      paragraph(
        "Zapisany profil jest niekompletny albo zawiera niedozwolone wartości, więc nie możemy " +
          "dobrać do niego zamówień.",
      ),
      `<p>Popraw go w ${link("/profil/ustawienia", "ustawieniach profilu")}.</p>`,
    ]),
  };
}

/** 503 on /dopasowania while this server computes another list (one at a time, D-027). */
export function matchesBusyPage(): Page {
  return {
    status: 503,
    html: layout("Pasujące zamówienia", [
      paragraph("Trwa przygotowanie listy dopasowań — spróbuj za kilka sekund."),
      `<p>${link("/dopasowania", "Spróbuj ponownie")}</p>`,
      backLinks(),
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

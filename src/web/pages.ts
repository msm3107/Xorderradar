import { escapeHtml } from "../infrastructure/html.js";

/**
 * The HTML pages of the web access (PR-06A). Polish, server-rendered, no
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
`;

const SITE_NAME = "Radar Zamówień";

/**
 * How a customer gets back in: the links are single-use and expire, and there is
 * no self-service re-issue (the operator runs access:link). One shared sentence,
 * so the 404 stays the same page for every token failure.
 */
const NEW_LINK_HINT =
  "Jeśli link został już użyty lub wygasł, odpowiedz na ostatnią wiadomość — operator wyśle nowy link.";

/** The way back after an unsubscribe; re-enabling is an operator action. */
const RESUBSCRIBE_HINT =
  "Jeśli to pomyłka, odpowiedz na ostatnią wiadomość — włączymy powiadomienia ponownie.";

function layout(title: string, body: readonly string[]): string {
  return [
    "<!doctype html>",
    '<html lang="pl">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
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
      paragraph("Kliknij przycisk, aby otworzyć swój profil. Link działa tylko raz."),
      form("/dostep", [hidden("token", token)], "Zaloguj się"),
    ]),
  };
}

/** One page for an unknown, used and expired link alike: nothing tells them apart. */
export function invalidLinkPage(): Page {
  return {
    status: 404,
    html: layout("Link jest nieaktywny", [
      paragraph(
        "Ten link jest nieprawidłowy, został już użyty albo wygasł. " +
          "Aktualny link znajdziesz w najnowszej wiadomości z Radaru Zamówień.",
      ),
      paragraph(NEW_LINK_HINT),
    ]),
  };
}

export function loginRequiredPage(): Page {
  return {
    status: 401,
    html: layout("Zaloguj się", [
      paragraph("Ta strona wymaga zalogowania. Użyj linku „Twój profil” z ostatniej wiadomości."),
      paragraph(NEW_LINK_HINT),
    ]),
  };
}

export interface ProfileView {
  readonly name: string;
  readonly active: boolean;
}

/** GET /profil: the signed-in profile only; every form carries the CSRF token. */
export function profilePage(profile: ProfileView, csrfToken: string): Page {
  const csrf = hidden("csrf", csrfToken);
  return {
    status: 200,
    html: layout("Twój profil", [
      `<p>Firma: <strong>${escapeHtml(profile.name)}</strong></p>`,
      `<p>Powiadomienia: <span class="status">${
        profile.active ? "włączone" : "wyłączone"
      }</span></p>`,
      ...(profile.active
        ? [
            paragraph("Możesz wyłączyć codzienne powiadomienia e-mail dla tego profilu."),
            form("/profil/wypisz", [csrf], "Wypisz z powiadomień"),
          ]
        : [paragraph("Powiadomienia są wyłączone."), paragraph(RESUBSCRIBE_HINT)]),
      form("/wyloguj", [csrf], "Wyloguj"),
    ]),
  };
}

/** GET /wypis/<token>: confirms; only the POST (the RFC 8058 body) unsubscribes. */
export function unsubscribeConfirmPage(token: string): Page {
  return {
    status: 200,
    html: layout("Wypisanie z powiadomień", [
      paragraph("Kliknij przycisk, aby wyłączyć codzienne powiadomienia e-mail."),
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

export function errorPage(status: ErrorStatus): Page {
  const [title, text] = ERROR_TEXT[status];
  return { status, html: layout(title, [paragraph(text)]) };
}

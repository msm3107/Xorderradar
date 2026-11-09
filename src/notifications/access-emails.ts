import { emailConfirmUrl, loginUrl } from "../web/links.js";
import type { OutgoingEmail } from "./sender.js";

/**
 * The access e-mails of the web process (D-031): the „Wyślij mi link” login
 * link, the confirmation of a new address and the notice to the old one.
 * Plain text, no List-Unsubscribe (nobody subscribed to them), no company
 * name and no profile data: the first two can reach a mistyped address. A
 * link holds a secret: an e-mail built here is never logged.
 */

export const LOGIN_LINK_SUBJECT = "Radar Zamówień: link do profilu";
export const EMAIL_CHANGE_SUBJECT = "Radar Zamówień: potwierdź nowy adres e-mail";
export const EMAIL_CHANGE_NOTICE_SUBJECT = "Radar Zamówień: prośba o zmianę adresu e-mail";

const SIGNATURE = "Radar Zamówień";

/** The self-service login link (a login token: single use, 7 days). */
export function loginLinkEmail(publicBaseUrl: string, to: string, token: string): OutgoingEmail {
  const text = [
    "Dzień dobry,",
    "",
    "poproszono o link do profilu w Radarze Zamówień dla tego adresu.",
    "",
    "Link działa raz przez 7 dni:",
    loginUrl(publicBaseUrl, token),
    "",
    "Jeśli to nie Ty — zignoruj tę wiadomość. Bez kliknięcia w link nic się nie zmieni.",
    "",
    SIGNATURE,
    "",
  ].join("\n");
  return { to, subject: LOGIN_LINK_SUBJECT, text, listUnsubscribe: false };
}

/** The confirmation link sent to the new address (an `email_change` token: single use, 24 hours). */
export function emailChangeEmail(publicBaseUrl: string, to: string, token: string): OutgoingEmail {
  const text = [
    "Dzień dobry,",
    "",
    "poproszono o zmianę adresu powiadomień profilu w Radarze Zamówień na ten adres.",
    "",
    "Potwierdź zmianę — link działa raz przez 24 godziny:",
    emailConfirmUrl(publicBaseUrl, token),
    "",
    "Do potwierdzenia wiadomości i linki do profilu przychodzą na dotychczasowy adres.",
    "Jeśli to nie Ty — zignoruj tę wiadomość. Bez potwierdzenia nic się nie zmieni.",
    "",
    SIGNATURE,
    "",
  ].join("\n");
  return { to, subject: EMAIL_CHANGE_SUBJECT, text, listUnsubscribe: false };
}

/**
 * The notice to the current address. No link and not the new address: it
 * tells the owner of the profile that a change was asked for, without
 * handing anything to whoever reads a forwarded copy. The way back names the
 * „Twój profil” link of the daily message instead of carrying one, and
 * `contactEmail` (CONTACT_EMAIL) when set: the operator, once the change was
 * confirmed and the profile's links no longer reach this address.
 */
export function emailChangeNoticeEmail(to: string, contactEmail: string | null): OutgoingEmail {
  const text = [
    "Dzień dobry,",
    "",
    "poproszono o zmianę adresu e-mail profilu w Radarze Zamówień. Zmiana zacznie działać " +
      "dopiero po potwierdzeniu linkiem wysłanym na nowy adres; do tego czasu wiadomości " +
      "przychodzą tutaj.",
    "",
    "Jeśli to nie Ty, zaloguj się i anuluj zmianę: otwórz profil linkiem „Twój profil” " +
      "z ostatniej codziennej wiadomości albo poproś o nowy link na stronie głównej Radaru " +
      "Zamówień, a w profilu wybierz „Anuluj zmianę”.",
    "",
    contactEmail === null
      ? "Jeśli zmiana została już potwierdzona, napisz do operatora serwisu."
      : `Jeśli zmiana została już potwierdzona, napisz do operatora serwisu: ${contactEmail}.`,
    "",
    SIGNATURE,
    "",
  ].join("\n");
  return { to, subject: EMAIL_CHANGE_NOTICE_SUBJECT, text, listUnsubscribe: false };
}

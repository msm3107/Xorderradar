import type { CompanyProfile } from "../domain/company-profile.js";
import type { FeedbackVerdict } from "../infrastructure/db/schema.js";
import { escapeHtml } from "../infrastructure/html.js";
import { formatWarsawMinute } from "../sources/normalize/warsaw-time.js";
import {
  LINK_LABEL,
  MATCH_DETAILS_LABEL,
  OPEN_LABEL,
  URGENT_WORD,
  formatPolishDayMonth,
  offerCard,
  plural,
  safeLink,
  snippet,
  type CardRow,
  type MatchedOffer,
  type OfferCard,
} from "./card.js";

/** Re-exported: the escaping the digest uses (one implementation, src/infrastructure/html.ts). */
export { escapeHtml };
/** Re-exported: shared with the web pages and the tests (src/notifications/card.ts). */
export { plural, snippet, SNIPPET_MAX_CHARS } from "./card.js";

/**
 * The daily digest e-mail (docs/PRODUCT.md "Pojedynczy wynik w alercie",
 * "Digest"; D-024). Pure: no I/O, no clock — `now` (the run time) is passed
 * in. Each offer is the shared card (src/notifications/card.ts, PR-11),
 * rendered twice, as plain text and as HTML, so both carry the same content
 * as /dopasowania. Only what the source published is shown; a missing value
 * is omitted or "nie podano", never guessed.
 */

/** One matched offer and why it matched (matchOpportunity's reasons). */
export type DigestItem = MatchedOffer;

export interface DigestOptions {
  /** Matching offers left out of this e-mail by the per-e-mail cap. */
  readonly overflow: number;
  /**
   * The web links of this e-mail (PR-06A, D-024), when PUBLIC_BASE_URL is
   * set: a single-use login link ("Twój profil") and the one-click
   * unsubscribe link. Without them the footer asks for a reply instead.
   */
  readonly links?: DigestLinks;
}

export interface DigestLinks {
  readonly profileUrl: string;
  readonly unsubscribeUrl: string;
  /**
   * The rating link of one offer (PR-12, D-032): „Trafne”/„Nietrafne” under
   * every card, one multi-use token per e-mail. Absent: no rating links.
   */
  readonly feedbackUrl?: (opportunityId: string, verdict: FeedbackVerdict) => string;
}

export interface DigestEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Longest profile name put into the footer. */
const PROFILE_NAME_MAX_CHARS = 80;

/**
 * The one accent colour of the e-mail (borders and the button), the web's
 * light-scheme accent. White on it has a contrast of 6.3:1 (WCAG AA), and the
 * button sets both colours, so it reads in a dark mail client too. Text sets
 * no colour: it inherits the client's, light or dark.
 */
const ACCENT = "#1d5fb4";

/** The PILNE badge's background; sets its text colour too (white), so dark mail clients keep it. */
const URGENT_BACKGROUND = "#b3261e";

/**
 * A footer paragraph, optionally ending with a link: shown as its URL in the
 * text part, as `linkText` in the HTML part.
 */
interface FooterParagraph {
  readonly text: string;
  readonly href?: string;
  readonly linkText?: string;
}

/** The rating links of one card, http(s) only (safeLink). */
interface FeedbackLinks {
  readonly relevant: string;
  readonly notRelevant: string;
}

interface DigestCard {
  readonly card: OfferCard;
  /** null without rating links (no PUBLIC_BASE_URL, or a link safeLink refused). */
  readonly feedback: FeedbackLinks | null;
}

interface DigestModel {
  readonly heading: string;
  /** Shown right under the heading: matching offers left for later e-mails. */
  readonly overflowNotice: string | null;
  readonly cards: readonly DigestCard[];
  readonly footer: readonly FooterParagraph[];
}

/** "N nowe zamówienie" / "N nowe zamówienia" / "N nowych zamówień". */
function newOffers(count: number): string {
  return `${String(count)} ${plural(count, "nowe zamówienie", "nowe zamówienia", "nowych zamówień")}`;
}

/**
 * The subject's count: "1 nowe", "2 nowe", "5 nowych" — agreeing with the
 * body's "zamówienie" (newOffers), so one offer is "1 nowe" in both.
 */
export function newCount(count: number): string {
  return `${String(count)} ${plural(count, "nowe", "nowe", "nowych")}`;
}

/** "pasujące" / "pasujących", agreeing with newOffers(count). */
function matching(count: number): string {
  return plural(count, "pasujące", "pasujące", "pasujących");
}

/** "1 kolejne pasujące zamówienie wyślemy …, jeśli będzie …" and the plural forms. */
function overflowNotice(count: number): string {
  const offers = plural(
    count,
    "kolejne pasujące zamówienie",
    "kolejne pasujące zamówienia",
    "kolejnych pasujących zamówień",
  );
  const willBe = plural(count, "będzie", "będą", "będą");
  return `${String(count)} ${offers} wyślemy w następnych dniach, jeśli ${willBe} wtedy aktualne.`;
}

/**
 * Soonest deadline first (unknown last), then the latest published (unknown
 * last), then id. Also the order of the web page of matches (PR-06B).
 */
export function digestOrder(a: DigestItem, b: DigestItem): number {
  const deadlineA = a.offer.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
  const deadlineB = b.offer.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
  if (deadlineA !== deadlineB) return deadlineA < deadlineB ? -1 : 1;
  const publishedA = a.offer.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const publishedB = b.offer.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (publishedA !== publishedB) return publishedA > publishedB ? -1 : 1;
  return a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0;
}

/**
 * The subject: "Radar Zamówień: 3 nowe, najbliższy termin 18.11" — the count
 * and the earliest deadline not passed at `now` among the e-mail's offers, as
 * a day in Poland; without one, "Radar Zamówień: 3 nowe". Never the
 * recipient's company name (a forwarded or previewed subject would show it)
 * nor any text from a source.
 */
export function digestSubject(items: readonly DigestItem[], now: Date): string {
  const nearest = items.reduce<Date | null>((soonest, { offer: { deadline } }) => {
    if (deadline === null || deadline.getTime() < now.getTime()) return soonest;
    return soonest === null || deadline.getTime() < soonest.getTime() ? deadline : soonest;
  }, null);
  const subject = `Radar Zamówień: ${newCount(items.length)}`;
  return nearest === null
    ? subject
    : `${subject}, najbliższy termin ${formatPolishDayMonth(nearest)}`;
}

function profileName(profile: Pick<CompanyProfile, "name">): string {
  return snippet(profile.name, PROFILE_NAME_MAX_CHARS);
}

/** Labels of the rating links: the text part's lines, the HTML part's link texts. */
export const RATE_RELEVANT_LABEL = "Trafne";
export const RATE_NOT_RELEVANT_LABEL = "Nietrafne";
const RATE_QUESTION = "Czy to zamówienie pasuje?";

function feedbackLinks(
  links: DigestLinks | undefined,
  opportunityId: string,
): FeedbackLinks | null {
  const url = links?.feedbackUrl;
  if (url === undefined) return null;
  const relevant = safeLink(url(opportunityId, "relevant"));
  const notRelevant = safeLink(url(opportunityId, "not_relevant"));
  return relevant === null || notRelevant === null ? null : { relevant, notRelevant };
}

function digestModel(
  profile: Pick<CompanyProfile, "name">,
  items: readonly DigestItem[],
  now: Date,
  options: DigestOptions,
): DigestModel {
  const profileUrl = options.links === undefined ? null : safeLink(options.links.profileUrl);
  const unsubscribeUrl =
    options.links === undefined ? null : safeLink(options.links.unsubscribeUrl);
  const cards = [...items].sort(digestOrder).map((item) => ({
    card: offerCard(item, now),
    feedback: feedbackLinks(options.links, item.offer.id),
  }));
  const footer: FooterParagraph[] = [
    { text: `Stan na ${formatWarsawMinute(now)} (czas polski).` },
    {
      text:
        "Dane pochodzą z publicznych ogłoszeń. Termin mógł się zmienić, a postępowanie mogło " +
        "zostać odwołane — przed złożeniem oferty sprawdź ogłoszenie w źródle.",
    },
    {
      text:
        `Otrzymujesz tę wiadomość, ponieważ dla firmy „${profileName(profile)}” założono profil ` +
        "w Radarze Zamówień: raz dziennie wysyłamy nowe zamówienia pasujące do jego kategorii, " +
        "słów kluczowych i regionów.",
    },
    ...(cards.some((card) => card.feedback !== null)
      ? [
          {
            text:
              `Linki „${RATE_RELEVANT_LABEL}” i „${RATE_NOT_RELEVANT_LABEL}” przy zamówieniach ` +
              "otwierają stronę, na której jednym przyciskiem zapiszesz ocenę (bez logowania, " +
              "ważne 60 dni; ocenę możesz zmienić). Dzięki nim poprawiamy dopasowania.",
          },
        ]
      : []),
    ...(profileUrl === null
      ? []
      : [
          {
            // What the profile page offers (PR-09): the form and the matching offers.
            text:
              "Na stronie profilu możesz zmienić kategorie, regiony i słowa kluczowe oraz " +
              "zobaczyć wszystkie pasujące zamówienia. " +
              "Twój profil (link jednorazowy, ważny 7 dni; nie przekazuj tej wiadomości " +
              "dalej — link daje dostęp do profilu):",
            href: profileUrl,
            linkText: "Otwórz swój profil",
          },
        ]),
    unsubscribeUrl === null
      ? {
          text:
            "Aby zrezygnować z powiadomień, odpowiedz na tę wiadomość lub napisz do operatora " +
            "serwisu — wyłączymy profil.",
        }
      : {
          text: "Aby zrezygnować z powiadomień, otwórz ten link (albo odpowiedz na tę wiadomość):",
          href: unsubscribeUrl,
          linkText: "Wypisz się z powiadomień",
        },
  ];
  return {
    heading: `Znaleźliśmy dziś ${newOffers(items.length)} ${matching(items.length)} do Twojej firmy.`,
    overflowNotice: options.overflow > 0 ? overflowNotice(options.overflow) : null,
    cards,
    footer,
  };
}

/** A row's value with the urgency word before it (plain text). */
function rowText(row: CardRow): string {
  return row.urgent ? `${URGENT_WORD} ${row.value}` : row.value;
}

/**
 * One card as text: the title, the labelled rows, the link (the excerpt only,
 * never the full description) and the match details as the last line.
 */
function cardText({ card, feedback }: DigestCard, index: number): string[] {
  return [
    `${String(index + 1)}. ${card.title}`,
    ...card.rows.map((row) => `   ${row.label}: ${rowText(row)}`),
    ...(card.url === null ? [] : [`   ${LINK_LABEL}: ${card.url}`]),
    ...(card.matchDetails.length === 0
      ? []
      : [`   ${MATCH_DETAILS_LABEL}: ${card.matchDetails.join(" · ")}`]),
    ...(feedback === null
      ? []
      : [
          `   Oceń jako ${RATE_RELEVANT_LABEL.toLowerCase()}: ${feedback.relevant}`,
          `   Oceń jako ${RATE_NOT_RELEVANT_LABEL.toLowerCase()}: ${feedback.notRelevant}`,
        ]),
  ];
}

function renderText(model: DigestModel): string {
  const lines = [model.heading, ""];
  if (model.overflowNotice !== null) lines.push(model.overflowNotice, "");
  model.cards.forEach((card, index) => {
    lines.push(...cardText(card, index), "");
  });
  lines.push(
    "--",
    ...model.footer.flatMap((paragraph) => [
      paragraph.href === undefined ? paragraph.text : `${paragraph.text} ${paragraph.href}`,
      "",
    ]),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function rowHtml(row: CardRow): string {
  // A badge, so the word does not read as part of the bold label. Inline
  // style (mail clients drop <style>); white on URGENT_BACKGROUND is 6.5:1.
  const urgent = row.urgent
    ? `<b style="background:${URGENT_BACKGROUND};color:#fff;padding:0 4px">${URGENT_WORD}</b> `
    : "";
  return `<b>${escapeHtml(row.label)}:</b> ${urgent}${escapeHtml(row.value)}`;
}

/**
 * One card as HTML, inline-styled (mail clients drop <style>): a bordered
 * box in the accent colour, the rows, one "Otwórz ogłoszenie" button and the
 * match details as a small last line. No colour on text, no images or fonts.
 */
function cardHtml({ card, feedback }: DigestCard): string {
  const button =
    card.url === null
      ? ""
      : `<p><a href="${escapeHtml(card.url)}" style="display:inline-block;padding:6px 14px;` +
        `background:${ACCENT};color:#fff;text-decoration:none"><b>${OPEN_LABEL}</b></a></p>`;
  const details =
    card.matchDetails.length === 0
      ? ""
      : `<small>${MATCH_DETAILS_LABEL}: ${escapeHtml(card.matchDetails.join(" · "))}</small>`;
  // Plain links (no form: mail clients block them); the label names the offer for screen readers.
  const rate =
    feedback === null
      ? ""
      : `<p style="margin:10px 0 0"><small>${RATE_QUESTION}</small><br>` +
        `${rateLink(feedback.relevant, RATE_RELEVANT_LABEL, card.title)} ` +
        `${rateLink(feedback.notRelevant, RATE_NOT_RELEVANT_LABEL, card.title)}</p>`;
  return (
    `<div style="border:1px solid ${ACCENT};padding:0 12px 10px;margin:12px 0">` +
    `<h2 style="font-size:1.05em;margin:10px 0 6px">${escapeHtml(card.title)}</h2>` +
    `<p style="margin:0">${card.rows.map(rowHtml).join("<br>")}</p>` +
    `${button}${details}${rate}</div>`
  );
}

/**
 * The rating links' inline style: a bordered tap target (about 30 px high)
 * with a gap between the two, outlined only, so the filled „Otwórz
 * ogłoszenie” button stays the card's main action.
 */
const RATE_LINK_STYLE =
  `display:inline-block;padding:6px 12px;border:1px solid ${ACCENT};border-radius:4px;` +
  "margin:6px 16px 0 0";

function rateLink(href: string, label: string, title: string): string {
  return (
    `<a href="${escapeHtml(href)}" aria-label="${escapeHtml(`${label}: ${title}`)}" ` +
    `style="${RATE_LINK_STYLE}">${label}</a>`
  );
}

function renderHtml(model: DigestModel, subject: string): string {
  return [
    "<!doctype html>",
    '<html lang="pl">',
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="font-family:sans-serif;line-height:1.4">',
    `<p><strong>${escapeHtml(model.heading)}</strong></p>`,
    ...(model.overflowNotice === null ? [] : [`<p>${escapeHtml(model.overflowNotice)}</p>`]),
    ...model.cards.map(cardHtml),
    '<hr><div style="font-size:0.9em">',
    ...model.footer.map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph.text)}` +
        (paragraph.href === undefined
          ? ""
          : ` <a href="${escapeHtml(paragraph.href)}">` +
            `${escapeHtml(paragraph.linkText ?? paragraph.href)}</a>`) +
        "</p>",
    ),
    "</div></body></html>",
    "",
  ].join("\n");
}

/**
 * Builds one profile's digest. The subject holds the count and the nearest
 * deadline only (digestSubject). Items are sorted by deadline, soonest
 * first; the caller has already dropped offers past their deadline. `now`
 * (the run time) is shown as the time the digest was made and is what the
 * deadline lines count days from.
 */
export function buildDigest(
  profile: Pick<CompanyProfile, "name">,
  items: readonly DigestItem[],
  now: Date,
  options: DigestOptions,
): DigestEmail {
  const model = digestModel(profile, items, now, options);
  const subject = digestSubject(items, now);
  return { subject, text: renderText(model), html: renderHtml(model, subject) };
}

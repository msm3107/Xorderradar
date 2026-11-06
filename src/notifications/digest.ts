import type { CompanyProfile } from "../domain/company-profile.js";
import type {
  Opportunity,
  OpportunityContact,
  OpportunityLocation,
} from "../domain/opportunity.js";
import { escapeHtml } from "../infrastructure/html.js";
import { formatReasons } from "../matching/format.js";
import type { MatchReason } from "../matching/match.js";
import { ATTRIBUTION_LABEL, BK_SOURCE_ID, bkAttribution } from "../sources/bk/attribution.js";
import { mvpCategoriesForCpv } from "../sources/normalize/cpv-categories.js";
import { formatWarsawMinute, warsawDay } from "../sources/normalize/warsaw-time.js";
import { cleanText } from "../sources/normalize/whitespace.js";

/** Re-exported: the escaping the digest uses (one implementation, src/infrastructure/html.ts). */
export { escapeHtml };

/**
 * The daily digest e-mail (docs/PRODUCT.md "Pojedynczy wynik w alercie",
 * "Digest"; D-024). Pure: no I/O, no clock — `now` is passed in. One model
 * is rendered twice, as plain text and as HTML, so both carry the same
 * content. Only what the source published is shown; a missing value is
 * omitted or "nie podano", never guessed.
 */

/** One matched offer and why it matched (matchOpportunity's reasons). */
export interface DigestItem {
  readonly offer: Opportunity;
  readonly reasons: readonly MatchReason[];
}

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
}

export interface DigestEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Longest description snippet, in characters (graphemes). */
export const SNIPPET_MAX_CHARS = 300;
/** CPV codes shown per offer; the rest are counted. */
const CPV_CODES_SHOWN = 5;
/** Longest profile name put into the subject. */
const SUBJECT_NAME_MAX_CHARS = 80;
const NOT_GIVEN = "nie podano";

export interface DigestField {
  readonly label: string;
  readonly value: string;
  /** Set for a link: an http(s) URL, also the value shown. */
  readonly href?: string;
}

/** One offer as shown: its title and labelled fields, cleaned, not escaped yet. */
export interface DigestItemView {
  readonly title: string;
  readonly fields: readonly DigestField[];
}

/**
 * A footer paragraph, optionally ending with a link: shown as its URL in the
 * text part, as `linkText` in the HTML part.
 */
interface FooterParagraph {
  readonly text: string;
  readonly href?: string;
  readonly linkText?: string;
}

interface DigestModel {
  readonly heading: string;
  /** Shown right under the heading: matching offers left for later e-mails. */
  readonly overflowNotice: string | null;
  readonly items: readonly DigestItemView[];
  readonly footer: readonly FooterParagraph[];
}

/** Polish plural form for `count`: one, few (2–4, not 12–14), many. */
export function plural(count: number, one: string, few: string, many: string): string {
  if (count === 1) return one;
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? few : many;
}

/** "N nowe zamówienie" / "N nowe zamówienia" / "N nowych zamówień". */
function newOffers(count: number): string {
  return `${String(count)} ${plural(count, "nowe zamówienie", "nowe zamówienia", "nowych zamówień")}`;
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

const graphemes = new Intl.Segmenter("pl", { granularity: "grapheme" });

/** At most `max` characters (graphemes); longer text is cut at a word boundary and ends with "…". */
export function snippet(value: string, max: number = SNIPPET_MAX_CHARS): string {
  const chars = Array.from(graphemes.segment(cleanText(value)), (part) => part.segment);
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  // A boundary far back would waste most of the snippet: cut mid-word then.
  const head = lastSpace >= cut.length * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

function formatLocation(location: OpportunityLocation | null): string {
  if (location === null) return NOT_GIVEN;
  const parts = [
    location.city,
    location.county === undefined ? undefined : `powiat ${location.county}`,
    location.voivodeship === undefined ? undefined : `woj. ${location.voivodeship}`,
  ].filter((part): part is string => part !== undefined);
  if (parts.length > 0) return parts.join(", ");
  return location.raw ?? NOT_GIVEN;
}

function formatCategory(cpvCodes: readonly string[]): string {
  if (cpvCodes.length === 0) return NOT_GIVEN;
  const shown = cpvCodes.slice(0, CPV_CODES_SHOWN).join(", ");
  const more = cpvCodes.length - CPV_CODES_SHOWN;
  const codes = `CPV ${shown}${more > 0 ? ` i ${String(more)} ${plural(more, "inny", "inne", "innych")}` : ""}`;
  const categories = mvpCategoriesForCpv(cpvCodes);
  return categories.length === 0 ? codes : `${categories.join(", ")} (${codes})`;
}

function formatContact(contact: OpportunityContact | null): string | null {
  if (contact === null) return null;
  const parts = [contact.name, contact.email, contact.phone].filter(
    (part): part is string => part !== undefined,
  );
  if (parts.length > 0) return parts.join(", ");
  return contact.raw ?? null;
}

/** The source link when it is http(s); anything else (e.g. `javascript:`) is not shown. */
function safeLink(value: string): string | null {
  const url = URL.parse(value);
  return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
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
 * The attribution the Baza Konkurencyjności's terms of reuse require with each
 * of its offers (D-030). Other sources need none (BZP: D-015).
 */
function sourceAttribution(offer: Opportunity): string | null {
  return offer.sourceId === BK_SOURCE_ID ? bkAttribution(offer.fetchedAt) : null;
}

/**
 * One offer's title and fields, as the digest shows them; also used by the
 * web page of matches (PR-06B), so both show an offer the same way.
 */
export function digestItemView({ offer, reasons }: DigestItem): DigestItemView {
  const fields: DigestField[] = [
    { label: "Zamawiający", value: offer.issuerName },
    { label: "Lokalizacja", value: formatLocation(offer.location) },
    {
      label: "Termin składania ofert",
      value:
        offer.deadline === null ? NOT_GIVEN : `${formatWarsawMinute(offer.deadline)} (czas polski)`,
    },
    {
      label: "Data publikacji",
      value: offer.publishedAt === null ? NOT_GIVEN : warsawDay(offer.publishedAt),
    },
    { label: "Kategoria", value: formatCategory(offer.categories) },
  ];
  if (offer.description !== null) fields.push({ label: "Opis", value: snippet(offer.description) });
  const contact = formatContact(offer.contact);
  if (contact !== null) fields.push({ label: "Kontakt", value: contact });
  fields.push({ label: "Dlaczego pasuje", value: formatReasons(reasons) });
  const attribution = sourceAttribution(offer);
  if (attribution !== null) fields.push({ label: ATTRIBUTION_LABEL, value: attribution });
  const link = safeLink(offer.sourceUrl);
  // An unsafe link is not shown, but the line stays, so its absence is visible.
  fields.push(
    link === null
      ? { label: "Link", value: NOT_GIVEN }
      : { label: "Link", value: link, href: link },
  );
  // Stored text is clean already; cleaning again keeps a line break or a
  // control character out of the e-mail whatever the row holds.
  return {
    title: cleanText(offer.title),
    fields: fields.map((field) => ({ ...field, value: cleanText(field.value) })),
  };
}

function profileName(profile: Pick<CompanyProfile, "name">): string {
  return snippet(profile.name, SUBJECT_NAME_MAX_CHARS);
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
    ...(profileUrl === null
      ? []
      : [
          {
            text:
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
    items: [...items].sort(digestOrder).map(digestItemView),
    footer,
  };
}

function renderText(model: DigestModel): string {
  const lines = [model.heading, ""];
  if (model.overflowNotice !== null) lines.push(model.overflowNotice, "");
  model.items.forEach((item, index) => {
    lines.push(`${String(index + 1)}. ${item.title}`);
    for (const field of item.fields) lines.push(`   ${field.label}: ${field.value}`);
    lines.push("");
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

function renderField(field: DigestField): string {
  const value =
    field.href === undefined
      ? escapeHtml(field.value)
      : `<a href="${escapeHtml(field.href)}">${escapeHtml(field.value)}</a>`;
  return `<li><strong>${escapeHtml(field.label)}:</strong> ${value}</li>`;
}

function renderHtml(model: DigestModel, subject: string): string {
  const items = model.items.map(
    (item) =>
      `<li><h2 style="font-size:1.05em;margin:1em 0 0.3em">${escapeHtml(item.title)}</h2>` +
      `<ul style="padding-left:1em;margin:0">${item.fields.map(renderField).join("")}</ul></li>`,
  );
  return [
    "<!doctype html>",
    '<html lang="pl">',
    '<head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="font-family:sans-serif;line-height:1.4">',
    `<p><strong>${escapeHtml(model.heading)}</strong></p>`,
    ...(model.overflowNotice === null ? [] : [`<p>${escapeHtml(model.overflowNotice)}</p>`]),
    `<ol style="padding-left:1.2em">${items.join("")}</ol>`,
    '<hr><div style="font-size:0.9em;color:#555">',
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
 * Builds one profile's digest. The subject holds only the count and the
 * profile's name (operator data, cleaned of control characters and bounded),
 * never text from a source. Items are sorted by deadline, soonest first; the
 * caller has already dropped offers past their deadline. `now` is shown as the
 * time the digest was made.
 */
export function buildDigest(
  profile: Pick<CompanyProfile, "name">,
  items: readonly DigestItem[],
  now: Date,
  options: DigestOptions,
): DigestEmail {
  const model = digestModel(profile, items, now, options);
  const subject = `Radar Zamówień: ${newOffers(items.length)} — ${profileName(profile)}`;
  return { subject, text: renderText(model), html: renderHtml(model, subject) };
}

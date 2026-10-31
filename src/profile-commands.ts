import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { z } from "zod";
import {
  companyProfileInputSchema,
  type CompanyProfile,
  type CompanyProfileInput,
} from "./domain/company-profile.js";
import type { Opportunity } from "./domain/opportunity.js";
import { MVP_CATEGORIES, VOIVODESHIPS } from "./domain/vocabulary.js";
import { formatReasons } from "./matching/format.js";
import { countyKey, matchOpportunity, type MatchResult } from "./matching/match.js";
import { normalizeVoivodeship } from "./sources/normalize/regions.js";
import { cleanText } from "./sources/normalize/whitespace.js";

/**
 * Operator commands for company profiles and the match preview (PR-04,
 * D-023): reading and validating a profile file, and the text of
 * `match:preview`. No database access here; src/cli.ts wires the repositories.
 */

/** A profile file is a few hundred bytes; anything bigger is refused before it is parsed. */
export const PROFILE_FILE_MAX_BYTES = 64 * 1024;

/** Offers read by `match:preview` (newest first), unless --limit says otherwise. */
export const MATCH_PREVIEW_DEFAULT_LIMIT = 100;
export const MATCH_PREVIEW_MAX_LIMIT = 1000;

/** The allowed values of the closed-vocabulary fields, shown when such a field is invalid. */
const FIELD_HINTS: Readonly<Record<string, string>> = {
  categories: `categories: one or more of ${MVP_CATEGORIES.join(", ")}.`,
  voivodeships:
    "voivodeships: names of the 16 voivodeships " +
    `(e.g. ${VOIVODESHIPS.slice(0, 2).join(", ")}).`,
};

/** Reads at most `PROFILE_FILE_MAX_BYTES` bytes of a regular file; returns the bytes or an error message. */
async function readBoundedFile(path: string): Promise<Uint8Array | string> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO must not hang the command; it is refused below.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error: unknown) {
    return `Cannot open the profile file (${errorCode(error)}).`;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return "The profile file must be a regular file.";
    if (stats.size > PROFILE_FILE_MAX_BYTES) return profileFileTooBig();
    // One byte more than allowed: a file that grew after fstat is still refused.
    const buffer = new Uint8Array(PROFILE_FILE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > PROFILE_FILE_MAX_BYTES) return profileFileTooBig();
    return buffer.subarray(0, length);
  } catch (error: unknown) {
    return `Cannot read the profile file (${errorCode(error)}).`;
  } finally {
    await handle.close();
  }
}

function profileFileTooBig(): string {
  return `The profile file is larger than ${String(PROFILE_FILE_MAX_BYTES / 1024)} KiB.`;
}

/** The Node error code (ENOENT, EACCES, …): a fixed token, never a message or a path. */
function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "error";
  }
  return "error";
}

/**
 * Voivodeships may be written in any spelling `normalizeVoivodeship` knows
 * ("Mazowieckie", "woj. mazowieckie"); they are stored in the canonical form
 * the profile schema requires. An entry it does not know is left as it is for
 * the schema to refuse.
 */
function canonicalVoivodeships(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const voivodeships: unknown = Reflect.get(value, "voivodeships");
  if (!Array.isArray(voivodeships)) return value;
  return {
    ...value,
    voivodeships: voivodeships.map((entry: unknown) =>
      typeof entry === "string" ? (normalizeVoivodeship(entry) ?? entry) : entry,
    ),
  };
}

/** The fields a profile file may have, in schema order. */
const PROFILE_FIELDS = Object.keys(companyProfileInputSchema.shape);

/** Unknown keys shown at most, each at most this many characters. */
const UNKNOWN_FIELDS_SHOWN = 5;
const UNKNOWN_FIELD_MAX_LENGTH = 40;

/**
 * The message for keys the profile schema does not know, or null. The key
 * names come from the operator's own file, so they are shown — cleaned of
 * control characters and cut to a bounded length; values never are.
 */
function unknownFields(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const unknown = Object.keys(parsed).filter((key) => !PROFILE_FIELDS.includes(key));
  if (unknown.length === 0) return null;
  const shown = unknown.slice(0, UNKNOWN_FIELDS_SHOWN).map((key) => {
    // Cut by code points, so a surrogate pair is never split.
    const characters = Array.from(cleanText(key));
    const name = characters.slice(0, UNKNOWN_FIELD_MAX_LENGTH).join("");
    return `"${name}${characters.length > UNKNOWN_FIELD_MAX_LENGTH ? "…" : ""}"`;
  });
  const more =
    unknown.length > shown.length ? ` (+${String(unknown.length - shown.length)} more)` : "";
  return (
    `Invalid profile: unknown field ${shown.join(", ")}${more}. ` +
    `Allowed fields: ${PROFILE_FIELDS.join(", ")}.`
  );
}

/** Schema problems shown at most; the rest are counted. */
const ISSUES_SHOWN = 5;

/**
 * Zod issue codes whose message is shown as it is. Their texts come from the
 * schema (length bounds, "Invalid email address") or are ours (`custom`: the
 * refinements of the profile schema); none quotes the input. Not among them:
 * - `invalid_type`: zod's message names the received value for some inputs
 *   (JSON `1e999` is Infinity → "received Infinity"), so its text is built
 *   from `issue.expected` (the schema's type) only;
 * - `invalid_value`: its message lists every allowed value, which
 *   FIELD_HINTS says more briefly.
 * Any other code is shown as "invalid".
 */
const SHOWN_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "too_small",
  "too_big",
  "invalid_format",
  "custom",
]);

function isMissing(parsed: unknown, issue: z.core.$ZodIssue): boolean {
  const [key, ...rest] = issue.path;
  return (
    issue.code === "invalid_type" &&
    typeof key === "string" &&
    rest.length === 0 &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Object.hasOwn(parsed, key)
  );
}

function issueText(parsed: unknown, issue: z.core.$ZodIssue): string {
  if (isMissing(parsed, issue)) return "missing";
  if (issue.code === "invalid_type") return `expected ${issue.expected}`;
  if (issue.code === "invalid_value") return "not an allowed value";
  return SHOWN_MESSAGE_CODES.has(issue.code) ? cleanText(issue.message) : "invalid";
}

/**
 * The message for a file that fails the profile schema: each invalid field
 * path with what is wrong (at most ISSUES_SHOWN, the rest counted), then the
 * allowed values of the closed-vocabulary fields among them. Paths come from
 * the schema (unknown keys are refused before), messages from SHOWN_MESSAGE_CODES:
 * no input value is ever part of it.
 */
function schemaProblems(parsed: unknown, issues: readonly z.core.$ZodIssue[]): string {
  const path = (issue: z.core.$ZodIssue) => issue.path.map(String).join(".") || "(root)";
  const shown = issues
    .slice(0, ISSUES_SHOWN)
    .map((issue) => `${path(issue)} (${issueText(parsed, issue)})`);
  const more =
    issues.length > shown.length ? ` (+${String(issues.length - shown.length)} more)` : "";
  const fields = new Set(issues.map((issue) => String(issue.path[0])));
  const hints = Object.entries(FIELD_HINTS)
    .filter(([field]) => fields.has(field))
    .map(([, hint]) => ` ${hint}`);
  return cleanText(`Invalid profile: ${shown.join(", ")}${more}.${hints.join("")}`);
}

/**
 * `profile:create <file.json>`: the file's profile, validated, or a message
 * for the operator. Messages name the file problem or the invalid field paths,
 * what is wrong with them and the allowed values — never the file's content
 * (it holds an e-mail address; V8's JSON.parse messages quote the input, so
 * they are not used).
 */
export async function readProfileFile(path: string): Promise<CompanyProfileInput | string> {
  const bytes = await readBoundedFile(path);
  if (typeof bytes === "string") return bytes;
  let json: string;
  try {
    // A leading BOM is dropped by TextDecoder.
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "The profile file is not valid UTF-8.";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "The profile file is not valid JSON.";
  }
  const unknown = unknownFields(parsed);
  if (unknown !== null) return unknown;
  const result = companyProfileInputSchema.safeParse(canonicalVoivodeships(parsed));
  if (!result.success) return schemaProblems(parsed, result.error.issues);
  const profile: CompanyProfileInput = result.data;
  // Counties are kept as entered (no county dictionary, D-022), but an entry
  // that is no county name at all ("powiat", "m. st.") could never match.
  const counties = profile.counties.flatMap((county, index) =>
    countyKey(county) === null ? [`counties.${String(index)}`] : [],
  );
  if (counties.length > 0) {
    return `Invalid profile: ${counties.join(", ")} (not a county name).`;
  }
  return profile;
}

/** The profile as `profile:show` prints it. */
export function showProfile(profile: CompanyProfile): string {
  return `${JSON.stringify(profile)}\n`;
}

const warsawMinute = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Warsaw",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `YYYY-MM-DD HH:MM` in Poland's time (deadlines are Warsaw wall-clock times). */
export function formatWarsawMinute(instant: Date): string {
  const parts = new Map(warsawMinute.formatToParts(instant).map((part) => [part.type, part.value]));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.get(type) ?? "??";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

interface PreviewItem {
  readonly offer: Opportunity;
  readonly result: MatchResult;
  /** The deadline is before the preview's "now" (still shown, but last). */
  readonly pastDeadline: boolean;
  /** Position in the fetched list (newest first): the last tie-breaker. */
  readonly position: number;
}

/**
 * Offers still open to bids first: soonest deadline first, none last; offers
 * past their deadline after all of them, in the same order. Then the higher
 * score, then fetch order.
 */
function previewOrder(a: PreviewItem, b: PreviewItem): number {
  if (a.pastDeadline !== b.pastDeadline) return a.pastDeadline ? 1 : -1;
  const deadlineA = a.offer.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
  const deadlineB = b.offer.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
  if (deadlineA !== deadlineB) return deadlineA < deadlineB ? -1 : 1;
  if (a.result.score !== b.result.score) return b.result.score - a.result.score;
  return a.position - b.position;
}

/** "1 nieprawidłowy wiersz", "2 nieprawidłowe wiersze", "5 nieprawidłowych wierszy". */
function invalidRows(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (count === 1) return "1 nieprawidłowy wiersz";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) {
    return `${String(count)} nieprawidłowe wiersze`;
  }
  return `${String(count)} nieprawidłowych wierszy`;
}

export interface MatchPreviewOptions {
  /** The clock of the preview: a deadline before it is "po terminie". */
  readonly now: Date;
  /** Stored rows left out because they are invalid (listMatchCandidates). */
  readonly skipped: number;
}

/**
 * The text of `match:preview`: every matched offer with its score, title,
 * issuer, deadline, link and reasons, then "dopasowane X z Y" (plus the
 * number of skipped invalid rows, if any). An offer whose deadline has passed
 * is shown last with "(po terminie)": the stored status may lag behind the
 * deadline, and the operator should see the match rather than lose it. Source
 * text goes through `cleanText`, so control characters (terminal escapes) in
 * a title cannot reach the terminal. The offer's contact is never printed.
 */
export function formatMatchPreview(
  profile: CompanyProfile,
  candidates: readonly Opportunity[],
  options: MatchPreviewOptions,
): string {
  const now = options.now.getTime();
  const items = candidates
    .map((offer, position) => ({
      offer,
      result: matchOpportunity(offer, profile),
      pastDeadline: offer.deadline !== null && offer.deadline.getTime() < now,
      position,
    }))
    .filter((item) => item.result.matched)
    .sort(previewOrder);
  const lines = [`Profil: ${cleanText(profile.name)} (${profile.id})`];
  if (!profile.active) {
    lines.push("Uwaga: profil jest nieaktywny — nie dostaje powiadomień; to tylko podgląd.");
  }
  for (const { offer, result, pastDeadline } of items) {
    const deadline =
      offer.deadline === null
        ? "brak terminu"
        : `${formatWarsawMinute(offer.deadline)}${pastDeadline ? " (po terminie)" : ""}`;
    lines.push(
      "",
      `[${String(result.score)}] ${cleanText(offer.title)}`,
      `  zamawiający: ${cleanText(offer.issuerName)}`,
      `  termin: ${deadline}`,
      `  link: ${cleanText(offer.sourceUrl)}`,
      `  dlaczego: ${cleanText(formatReasons(result.reasons))}`,
    );
  }
  const skipped = options.skipped > 0 ? `, pominięto ${invalidRows(options.skipped)}` : "";
  lines.push("", `dopasowane ${String(items.length)} z ${String(candidates.length)}${skipped}`);
  return `${lines.join("\n")}\n`;
}

import type { z } from "zod";
import { hasControlCharacter } from "../domain/common.js";
import {
  companyProfileSettingsSchema,
  MAX_KEYWORD_TOKENS,
  type CompanyProfileSettings,
} from "../domain/company-profile.js";
import type { StoredProfileSettings } from "../infrastructure/db/company-profiles-repository.js";
import { plural } from "../notifications/digest.js";

/**
 * The profile form (PR-06B, D-027, D-031, PR-13): the submitted values, their
 * validation with the domain schema (reused, no rule is repeated here), the
 * region choice and the Polish message for each issue. Counties are not on
 * the form since PR-13: only the operator sets them (a save leaves them as
 * stored). Pure: no I/O.
 */

/** The form's fields that occur once (urlencoded names); `region` is the radio pair. */
export const PROFILE_FORM_SINGLE_FIELDS = [
  "csrf",
  "name",
  "email",
  "region",
  "include_keywords",
  "exclude_keywords",
] as const;
/** The checkbox groups: any number of values, also none. */
export const PROFILE_FORM_MULTIPLE_FIELDS = ["categories", "voivodeships"] as const;

/**
 * The region radio's values (PR-13): the whole country, or only the ticked
 * voivodeships. The choice is explicit, so an empty list is never a forgotten
 * one.
 */
export const REGION_ALL = "all";
export const REGION_SELECTED = "selected";

/** What the customer sees in the form; textareas hold one entry per line. */
export interface ProfileFormValues {
  readonly name: string;
  readonly email: string;
  readonly categories: readonly string[];
  /** The region radio as submitted: REGION_ALL, REGION_SELECTED or anything else (refused). */
  readonly region: string;
  readonly voivodeships: readonly string[];
  readonly includeKeywords: string;
  readonly excludeKeywords: string;
}

/** A field with a label and its own messages; the region radio's go to `voivodeships`. */
export type ProfileFormField = Exclude<keyof ProfileFormValues, "region">;

/** Polish messages per field, in the order of the form. */
export type ProfileFormErrors = Partial<Record<ProfileFormField, readonly string[]>>;

/** The form's field labels, also used by the error summary. */
export const FIELD_LABELS: Readonly<Record<ProfileFormField, string>> = {
  name: "Nazwa firmy",
  email: "Adres e-mail",
  categories: "Kategorie",
  voivodeships: "Województwa",
  includeKeywords: "Słowa kluczowe",
  excludeKeywords: "Słowa wykluczające",
};

/** The order of the fields on the page (and in the error summary). */
export const FIELD_ORDER: readonly ProfileFormField[] = [
  "name",
  "email",
  "categories",
  "voivodeships",
  "includeKeywords",
  "excludeKeywords",
];

/** Messages shown per field at most; the rest are counted. */
const MESSAGES_SHOWN = 5;

/** A textarea's entries: one per line, trimmed, blank lines left out. */
interface Entry {
  readonly value: string;
  /** 1-based line number in the textarea, for the message. */
  readonly line: number;
}

function entries(text: string): Entry[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter((entry) => entry.value !== "");
}

/** The stored profile as form values (the current address, not a pending one). */
export function formValuesFromStored(stored: StoredProfileSettings): ProfileFormValues {
  return {
    name: stored.name,
    email: stored.email,
    categories: stored.categories,
    region: stored.voivodeships.length === 0 ? REGION_ALL : REGION_SELECTED,
    voivodeships: stored.voivodeships,
    includeKeywords: stored.includeKeywords.join("\n"),
    excludeKeywords: stored.excludeKeywords.join("\n"),
  };
}

/** The submitted form (already parsed: each single field once, lists as sent). */
export function formValuesFromSubmission(
  single: Readonly<Record<(typeof PROFILE_FORM_SINGLE_FIELDS)[number], string>>,
  multiple: Readonly<Record<(typeof PROFILE_FORM_MULTIPLE_FIELDS)[number], readonly string[]>>,
): ProfileFormValues {
  return {
    name: single.name,
    email: single.email,
    categories: multiple.categories,
    region: single.region,
    voivodeships: multiple.voivodeships,
    includeKeywords: single.include_keywords,
    excludeKeywords: single.exclude_keywords,
  };
}

export type ProfileFormResult =
  | { readonly ok: true; readonly settings: CompanyProfileSettings }
  | { readonly ok: false; readonly errors: ProfileFormErrors };

/** Schema field → form field: the same names but for the textareas' line lists. */
const SCHEMA_FIELDS: Readonly<Record<string, ProfileFormField>> = {
  name: "name",
  email: "email",
  categories: "categories",
  voivodeships: "voivodeships",
  includeKeywords: "includeKeywords",
  excludeKeywords: "excludeKeywords",
};

/**
 * The stored profile's fields a form save rewrites (PR-13). Not `counties`
 * (the operator's only), `email` (a new address waits in pending_email, the
 * stored one stays) or `active` (its own buttons).
 */
const FORM_REWRITTEN_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "categories",
  "voivodeships",
  "includeKeywords",
  "excludeKeywords",
]);

/**
 * Can saving the form correct a stored profile the schema refuses at these
 * field paths (DomainError `invalid_stored_row`, e.g. `counties.0`)? Only
 * when every path is a field the form rewrites; anything else (or no path)
 * needs the operator.
 */
export function correctableInForm(fields: readonly string[]): boolean {
  return (
    fields.length > 0 &&
    fields.every((path) => FORM_REWRITTEN_FIELDS.has(path.split(".", 1)[0] ?? ""))
  );
}

/** The region radio's messages (PR-13). */
export const REGION_ERRORS = {
  unknown: "Wybierz „Cała Polska” albo „Wybrane województwa”.",
  selectedWithout: "Zaznacz co najmniej jedno województwo albo wybierz „Cała Polska”.",
} as const;

/**
 * The region radio against the ticked voivodeships; null when they agree.
 * „Cała Polska” always agrees: its ticks are discarded (validateProfileForm).
 */
function regionError(values: ProfileFormValues): string | null {
  if (values.region === REGION_ALL) return null;
  if (values.region === REGION_SELECTED) {
    return values.voivodeships.length > 0 ? null : REGION_ERRORS.selectedWithout;
  }
  return REGION_ERRORS.unknown;
}

/**
 * Validates the form with the domain's settings schema. A new address is not
 * typed twice: it takes effect only through the confirmation link sent to it
 * (D-031), so a typo cannot lock the customer out. The region radio is the
 * explicit choice (PR-13, owner's decision in the review of PR #19): with
 * „Cała Polska” the ticked voivodeships are discarded unvalidated and an
 * empty list is saved — the page has no script, so boxes ticked before the
 * radio changed are still sent. „Wybrane województwa” needs one ticked.
 */
export function validateProfileForm(values: ProfileFormValues): ProfileFormResult {
  const lists = {
    includeKeywords: entries(values.includeKeywords),
    excludeKeywords: entries(values.excludeKeywords),
  };
  const input = {
    name: values.name,
    email: values.email,
    categories: values.categories,
    voivodeships: values.region === REGION_ALL ? [] : values.voivodeships,
    includeKeywords: lists.includeKeywords.map((entry) => entry.value),
    excludeKeywords: lists.excludeKeywords.map((entry) => entry.value),
  };
  const result = companyProfileSettingsSchema.safeParse(input);
  const found = new Map<ProfileFormField, string[]>();
  const add = (field: ProfileFormField, message: string): void => {
    const messages = found.get(field) ?? [];
    if (!messages.includes(message)) messages.push(message);
    found.set(field, messages);
  };

  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = SCHEMA_FIELDS[String(issue.path[0])];
      // Every schema field is on the form; an unknown path would be a bug.
      if (field === undefined) throw new Error("Profile form issue outside the form's fields");
      const index = issue.path[1];
      const list = field === "includeKeywords" || field === "excludeKeywords" ? lists[field] : [];
      const line = typeof index === "number" ? list[index]?.line : undefined;
      add(field, issueMessage(field, issue, line));
    }
  }
  const region = regionError(values);
  if (region !== null) add("voivodeships", region);
  // Control characters (a pasted tab, NUL): refused here and by profile:create,
  // never by the stored-row schema (D-028). Entries are trimmed like the schema does.
  if (hasControlCharacter(values.name.trim())) {
    add("name", "Nazwa firmy zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.");
  }
  for (const field of ["includeKeywords", "excludeKeywords"] as const) {
    for (const entry of lists[field]) {
      if (!hasControlCharacter(entry.value)) continue;
      add(
        field,
        `Wiersz ${String(entry.line)}: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.`,
      );
    }
  }
  if (result.success && found.size === 0) return { ok: true, settings: result.data };
  return { ok: false, errors: capped(found) };
}

/**
 * A new address while the profile had ACCESS_EMAILS_PER_DAY confirmation
 * e-mails in the last 24 hours (D-031): nothing is saved, not even the other
 * fields — the form shows them again, and with the current address restored
 * they save (updateProfileSettings).
 */
export const EMAIL_CHANGE_LIMIT_ERRORS: ProfileFormErrors = {
  email: [
    "W ciągu doby wysłaliśmy już 3 linki potwierdzające zmianę adresu. Nie zapisaliśmy " +
      "żadnej zmiany. Nowy adres zapiszesz po upływie doby. Pozostałe zmiany zapiszesz " +
      "teraz, wpisując z powrotem obecny adres.",
  ],
};

function capped(found: ReadonlyMap<ProfileFormField, readonly string[]>): ProfileFormErrors {
  const errors: Partial<Record<ProfileFormField, readonly string[]>> = {};
  for (const field of FIELD_ORDER) {
    const messages = found.get(field);
    if (messages === undefined) continue;
    const more = messages.length - MESSAGES_SHOWN;
    errors[field] = more > 0 ? [...messages.slice(0, MESSAGES_SHOWN), moreErrors(more)] : messages;
  }
  return errors;
}

/** "Oraz 1 inny błąd w tym polu." and the plural forms. */
function moreErrors(count: number): string {
  const noun = plural(count, "inny błąd", "inne błędy", "innych błędów");
  return `Oraz ${String(count)} ${noun} w tym polu.`;
}

/** Too many entries in a list (the schema allows 100). */
const LIST_LIMITS: Partial<Record<ProfileFormField, string>> = {
  includeKeywords: "Wpisz najwyżej 100 słów kluczowych, jedno w wierszu.",
  excludeKeywords: "Wpisz najwyżej 100 słów wykluczających, jedno w wierszu.",
};

/**
 * The Polish message of one schema issue. The schema's refinements carry
 * English messages; they are told apart by their text, and a test pins each
 * one, so a changed message shows up as a failing test, not a wrong hint.
 */
function issueMessage(
  field: ProfileFormField,
  issue: z.core.$ZodIssue,
  line: number | undefined,
): string {
  const inLine = (text: string): string =>
    line === undefined ? `Wpis: ${text}.` : `Wiersz ${String(line)}: ${text}.`;
  switch (field) {
    case "name":
      if (issue.code === "too_small") return "Podaj nazwę firmy.";
      if (issue.code === "too_big") return "Nazwa firmy może mieć najwyżej 200 znaków.";
      return "Nazwa firmy zawiera niedozwolone znaki.";
    case "email":
      if (issue.code === "too_big") return "Adres e-mail jest za długi.";
      return "Podaj poprawny adres e-mail, na przykład nazwa@firma.pl.";
    case "categories":
      if (issue.code === "too_small") return "Wybierz co najmniej jedną kategorię.";
      return "Wybierz kategorie z listy.";
    case "voivodeships":
      return "Wybierz województwa z listy.";
    case "includeKeywords":
    case "excludeKeywords":
      if (issue.path.length === 1) {
        return LIST_LIMITS[field] ?? "Wpisz najwyżej 100 pozycji, każdą w osobnym wierszu.";
      }
      if (issue.code === "too_big") return inLine("najwyżej 100 znaków");
      if (issue.code === "custom" && issue.message.includes("letter or a digit")) {
        return inLine("wpis musi zawierać literę lub cyfrę");
      }
      if (issue.code === "custom" && issue.message.includes("words")) {
        return inLine(`najwyżej ${String(MAX_KEYWORD_TOKENS)} słów`);
      }
      return inLine("wpis zawiera niedozwolone znaki");
  }
}

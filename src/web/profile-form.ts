import type { z } from "zod";
import { emailSchema } from "../domain/common.js";
import {
  companyProfileSettingsSchema,
  MAX_KEYWORD_TOKENS,
  type CompanyProfileSettings,
} from "../domain/company-profile.js";
import type { MvpCategory } from "../domain/vocabulary.js";
import type { StoredProfileSettings } from "../infrastructure/db/company-profiles-repository.js";
import { countyKey } from "../matching/match.js";
import { plural } from "../notifications/digest.js";

/**
 * The profile form (PR-06B, D-027): the submitted values, their validation
 * with the domain schema plus profile:create's county-name check (both
 * reused, no rule is repeated here) and the Polish message for each issue.
 * Pure: no I/O.
 */

/** The form's fields that occur once (urlencoded names). */
export const PROFILE_FORM_SINGLE_FIELDS = [
  "csrf",
  "name",
  "email",
  "email_confirm",
  "counties",
  "include_keywords",
  "exclude_keywords",
] as const;
/** The checkbox groups: any number of values, also none. */
export const PROFILE_FORM_MULTIPLE_FIELDS = ["categories", "voivodeships"] as const;

/** What the customer sees in the form; textareas hold one entry per line. */
export interface ProfileFormValues {
  readonly name: string;
  readonly email: string;
  readonly emailConfirm: string;
  readonly categories: readonly string[];
  readonly voivodeships: readonly string[];
  readonly counties: string;
  readonly includeKeywords: string;
  readonly excludeKeywords: string;
}

export type ProfileFormField = keyof ProfileFormValues;

/** Polish messages per field, in the order of the form. */
export type ProfileFormErrors = Partial<Record<ProfileFormField, readonly string[]>>;

/** The form's field labels, also used by the error summary. */
export const FIELD_LABELS: Readonly<Record<ProfileFormField, string>> = {
  name: "Nazwa firmy",
  email: "Adres e-mail",
  emailConfirm: "Powtórz adres e-mail",
  categories: "Kategorie",
  voivodeships: "Województwa",
  counties: "Powiaty",
  includeKeywords: "Słowa kluczowe",
  excludeKeywords: "Słowa wykluczające",
};

/** The order of the fields on the page (and in the error summary). */
export const FIELD_ORDER: readonly ProfileFormField[] = [
  "name",
  "email",
  "emailConfirm",
  "categories",
  "voivodeships",
  "counties",
  "includeKeywords",
  "excludeKeywords",
];

/**
 * Polish names of the MVP categories, describing what their CPV prefixes
 * cover (src/sources/normalize/cpv-categories.ts).
 */
export const CATEGORY_LABELS: Readonly<Record<MvpCategory, string>> = {
  bhp: "BHP",
  elektryka: "Elektryka",
  instalacje: "Instalacje budowlane (wod.-kan., ogrzewanie, wentylacja)",
  it: "IT (usługi, oprogramowanie, sprzęt komputerowy)",
  ppoz: "Ochrona przeciwpożarowa",
  remonty: "Roboty wykończeniowe i remonty",
  serwis: "Serwis, naprawy i konserwacja",
  sprzatanie: "Sprzątanie",
  szkolenia: "Szkolenia",
  wyposazenie: "Meble i wyposażenie",
};

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

/** The stored profile as form values (the e-mail confirmation starts empty). */
export function formValuesFromStored(stored: StoredProfileSettings): ProfileFormValues {
  return {
    name: stored.name,
    email: stored.email,
    emailConfirm: "",
    categories: stored.categories,
    voivodeships: stored.voivodeships,
    counties: stored.counties.join("\n"),
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
    emailConfirm: single.email_confirm,
    categories: multiple.categories,
    voivodeships: multiple.voivodeships,
    counties: single.counties,
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
  counties: "counties",
  includeKeywords: "includeKeywords",
  excludeKeywords: "excludeKeywords",
};

/**
 * Validates the form with the domain's settings schema. `currentEmail` is the
 * stored address: a different one must be typed twice (the confirmation is
 * compared after the schema's normalization, so case and spaces do not count).
 */
export function validateProfileForm(
  values: ProfileFormValues,
  currentEmail: string,
): ProfileFormResult {
  const lists = {
    counties: entries(values.counties),
    includeKeywords: entries(values.includeKeywords),
    excludeKeywords: entries(values.excludeKeywords),
  };
  const input = {
    name: values.name,
    email: values.email,
    categories: values.categories,
    voivodeships: values.voivodeships,
    counties: lists.counties.map((entry) => entry.value),
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

  const countyIssues = new Set<number>();
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = SCHEMA_FIELDS[String(issue.path[0])];
      // Every schema field is on the form; an unknown path would be a bug.
      if (field === undefined) throw new Error("Profile form issue outside the form's fields");
      const index = issue.path[1];
      const list =
        field === "counties" || field === "includeKeywords" || field === "excludeKeywords"
          ? lists[field]
          : [];
      const line = typeof index === "number" ? list[index]?.line : undefined;
      if (field === "counties" && typeof index === "number") countyIssues.add(index);
      add(field, issueMessage(field, issue, line));
    }
  }
  // The rule of profile:create (src/profile-commands.ts): an entry that is no
  // county name at all ("powiat", "m. st.") could never match an offer.
  lists.counties.forEach((entry, index) => {
    if (!countyIssues.has(index) && countyKey(entry.value) === null) {
      add(
        "counties",
        `Wiersz ${String(entry.line)}: wpisz nazwę powiatu, np. warszawski zachodni.`,
      );
    }
  });
  const email = result.success ? result.data.email : emailSchema.safeParse(values.email).data;
  if (email !== undefined && email !== currentEmail) {
    const confirmation = emailSchema.safeParse(values.emailConfirm).data;
    if (confirmation !== email) {
      add(
        "emailConfirm",
        values.emailConfirm.trim() === ""
          ? "Wpisz nowy adres e-mail jeszcze raz."
          : "Adresy e-mail różnią się. Wpisz nowy adres dwa razy tak samo.",
      );
    }
  }
  if (result.success && found.size === 0) return { ok: true, settings: result.data };
  return { ok: false, errors: capped(found) };
}

/** The message shown when another profile uses the address (UNIQUE violation). */
export const DUPLICATE_EMAIL_ERRORS: ProfileFormErrors = {
  email: [
    "Ten adres e-mail jest już przypisany do innego profilu. Jeśli to Twój drugi profil, " +
      "odpowiedz na ostatnią wiadomość.",
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
  counties: "Wpisz najwyżej 100 powiatów, każdy w osobnym wierszu.",
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
    case "counties":
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
    case "emailConfirm":
      // Not a schema field: its messages come from validateProfileForm.
      return "Wpisz nowy adres e-mail jeszcze raz.";
  }
}

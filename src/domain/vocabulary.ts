/**
 * Closed vocabularies of the product, shared by the profile schema (domain),
 * the source normalization helpers and matching (D-023). They live in the
 * domain, which imports nothing but zod, so `domain` can validate profiles
 * against them and `sources/normalize` can keep using them (sources may
 * depend on domain).
 */

/** The closed list of MVP categories (docs/PRODUCT.md), sorted. */
export const MVP_CATEGORIES = [
  "bhp",
  "elektryka",
  "instalacje",
  "it",
  "ppoz",
  "remonty",
  "serwis",
  "sprzatanie",
  "szkolenia",
  "wyposazenie",
] as const;
export type MvpCategory = (typeof MVP_CATEGORIES)[number];

/**
 * Polish names of the MVP categories, describing what their CPV prefixes
 * cover (src/sources/normalize/cpv-categories.ts). What a customer sees (the
 * profile form, the digest, the web page of matches) — never the keys.
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

/** The 16 voivodeships, canonical form: lower case, Polish letters (as stored in `location.voivodeship`). */
export const VOIVODESHIPS = [
  "dolnośląskie",
  "kujawsko-pomorskie",
  "lubelskie",
  "lubuskie",
  "łódzkie",
  "małopolskie",
  "mazowieckie",
  "opolskie",
  "podkarpackie",
  "podlaskie",
  "pomorskie",
  "śląskie",
  "świętokrzyskie",
  "warmińsko-mazurskie",
  "wielkopolskie",
  "zachodniopomorskie",
] as const;
export type Voivodeship = (typeof VOIVODESHIPS)[number];

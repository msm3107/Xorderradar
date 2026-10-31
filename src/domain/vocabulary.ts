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

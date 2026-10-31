/**
 * CPV code → MVP categories (D-022), a pure function for matching (PR-04).
 * Offers keep the CPV codes from the source in `categories`; the dictionary is
 * applied at matching time, so tuning it takes effect at once, without a
 * re-ingest and without changing any `content_hash`.
 */

/** The closed list of MVP categories (sorted). */
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
 * Prefixes of the 8 CPV digits per category, a calibratable starting point
 * (D-022): a code belongs to every category with a matching prefix, so one
 * code may map to several (e.g. 45312100 fire alarms → elektryka and ppoz,
 * 50413200 fire-equipment repair → ppoz and serwis, 50232 maintenance of
 * public lighting and traffic signals → elektryka and serwis). "4530" matches only the parent 45300000
 * (building installation work); no broader construction prefix (45, 452) is
 * mapped. Deliberately absent: 0931 (electricity supply — energy purchase, not
 * electrical work).
 */
const PREFIXES: Readonly<Record<MvpCategory, readonly string[]>> = {
  bhp: ["713172", "80550", "181", "351134"],
  elektryka: ["4531", "31", "50532", "50711", "50232"],
  instalacje: ["4530", "4533", "4535"],
  it: ["72", "48", "302", "50312", "5032"],
  ppoz: ["453121", "45343", "3511", "316252", "44480", "504132", "713171"],
  remonty: ["454"],
  serwis: ["50"],
  sprzatanie: ["909", "9061"],
  szkolenia: ["804", "805"],
  wyposazenie: ["391", "392"],
};

/** A CPV code as stored in `categories` ("45310000-3"); anything else is ignored. */
const CPV_CODE = /^(\d{8})-\d$/;

/**
 * The MVP categories of a list of CPV codes: sorted, unique; a code that is
 * malformed or matches no prefix adds nothing (an unknown code is never
 * guessed into a category), so no match → []. The check digit is not
 * verified: BZP publishes it, and a wrong one would not make the prefix less
 * meaningful.
 */
export function mvpCategoriesForCpv(codes: readonly string[]): MvpCategory[] {
  const found = new Set<MvpCategory>();
  for (const code of codes) {
    const digits = CPV_CODE.exec(code)?.[1];
    if (digits === undefined) continue;
    for (const category of MVP_CATEGORIES) {
      if (PREFIXES[category].some((prefix) => digits.startsWith(prefix))) found.add(category);
    }
  }
  return MVP_CATEGORIES.filter((category) => found.has(category));
}

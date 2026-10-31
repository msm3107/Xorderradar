import { describe, expect, it } from "vitest";
import { bzpProvinces } from "../src/sources/bzp/provinces.js";
import { comparableText } from "../src/sources/normalize/comparable.js";
import { MVP_CATEGORIES, mvpCategoriesForCpv } from "../src/sources/normalize/cpv-categories.js";
import {
  normalizeCounty,
  normalizeVoivodeship,
  VOIVODESHIPS,
} from "../src/sources/normalize/regions.js";
import { cleanText, collapseWhitespace } from "../src/sources/normalize/whitespace.js";

describe("collapseWhitespace / cleanText", () => {
  it("collapses every Unicode space, including NBSP and narrow NBSP, and trims", () => {
    expect(collapseWhitespace(" \t Zakład  Gospodarki Komunalnej \n ")).toBe(
      "Zakład Gospodarki Komunalnej",
    );
    expect(collapseWhitespace(" \n\t ")).toBe("");
  });

  it("keeps Polish letters and punctuation unchanged", () => {
    expect(collapseWhitespace("Żółć – „gęślą jaźń”")).toBe("Żółć – „gęślą jaźń”");
  });

  it("turns control characters (also NUL and DEL) into spaces before collapsing", () => {
    expect(cleanText("a\u0000b\u0007\u0007c\u007fd")).toBe("a b c d");
    expect(cleanText("\u0001\u0002")).toBe("");
  });

  it("turns C1 controls, including NEL (U+0085), into spaces", () => {
    expect(cleanText("a\u0080b\u0085c\u009fd")).toBe("a b c d");
    expect(cleanText("linia\u0085\u0085druga")).toBe("linia druga");
  });

  it("removes bidi controls and zero-width characters without splitting words", () => {
    const bidi = ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e"];
    const isolates = ["\u2066", "\u2067", "\u2068", "\u2069"];
    const zeroWidth = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"];
    for (const char of [...bidi, ...isolates, ...zeroWidth]) {
      const code = char.codePointAt(0)?.toString(16);
      expect(cleanText(`zam${char}ówienie ${char}IT${char}`), code).toBe("zamówienie IT");
      expect(cleanText(char.repeat(3)), code).toBe("");
    }
  });

  it("keeps other format-free text, also non-Latin letters and emoji, unchanged", () => {
    expect(cleanText("Żółć – „gęślą jaźń” عربى 😀")).toBe("Żółć – „gęślą jaźń” عربى 😀");
  });
});

describe("comparableText (comparisons only)", () => {
  it("lower-cases and strips every Polish diacritic, including ł/Ł", () => {
    expect(comparableText("ĄĆĘŁŃÓŚŹŻ ąćęłńóśźż")).toBe("acelnoszz acelnoszz");
    expect(comparableText("  Łódź  Śródmieście ")).toBe("lodz srodmiescie");
  });

  it("treats precomposed and decomposed input alike", () => {
    expect(comparableText("Zakład ó")).toBe(comparableText("Zakład ó"));
  });

  it("is linear on a long run of combining marks (no quadratic normalization)", () => {
    const hostile = "a" + "̖́".repeat(500_000);
    const started = performance.now();
    expect(comparableText(hostile)).toBe("a");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("normalizeVoivodeship", () => {
  it("returns every canonical name for itself", () => {
    for (const name of VOIVODESHIPS) expect(normalizeVoivodeship(name)).toBe(name);
    expect(VOIVODESHIPS).toHaveLength(16);
  });

  it("accepts letter case, a woj./województwo prefix and missing Polish letters", () => {
    expect(normalizeVoivodeship("Mazowieckie")).toBe("mazowieckie");
    expect(normalizeVoivodeship("WOJ. ŚLĄSKIE")).toBe("śląskie");
    expect(normalizeVoivodeship("woj.slaskie")).toBe("śląskie");
    expect(normalizeVoivodeship("woj śląskie")).toBe("śląskie");
    expect(normalizeVoivodeship("Województwo Łódzkie")).toBe("łódzkie");
    expect(normalizeVoivodeship("wojewodztwo lodzkie")).toBe("łódzkie");
    expect(normalizeVoivodeship("swietokrzyskie")).toBe("świętokrzyskie");
    expect(normalizeVoivodeship("Dolnoslaskie")).toBe("dolnośląskie");
    expect(normalizeVoivodeship("  warminsko - mazurskie ")).toBe("warmińsko-mazurskie");
    expect(normalizeVoivodeship("Kujawsko-Pomorskie")).toBe("kujawsko-pomorskie");
  });

  it("never guesses: unknown, partial, misspelt, empty or overlong input → null", () => {
    for (const value of [
      "",
      "woj.",
      "mazowsze",
      "mazowiecki",
      "pomorze",
      "kujawsko pomorskie",
      "Warszawa",
      "PL14",
      "mazowieckie ".repeat(10),
      "__proto__",
      "constructor",
    ]) {
      expect(normalizeVoivodeship(value), value).toBeNull();
    }
  });

  it("covers every BZP province name (provinces map ⊂ canonical list)", () => {
    const canonical: readonly string[] = VOIVODESHIPS;
    expect([...bzpProvinces.values()].sort()).toEqual([...canonical].sort());
  });
});

describe("normalizeCounty", () => {
  it("strips the powiat/pow. prefix, collapses whitespace and lower-cases, keeping Polish letters", () => {
    expect(normalizeCounty("Powiat Łódzki Wschodni")).toBe("łódzki wschodni");
    expect(normalizeCounty("pow. piaseczyński")).toBe("piaseczyński");
    expect(normalizeCounty("pow.piaseczyński")).toBe("piaseczyński");
    expect(normalizeCounty("POWIAT  m.st.\tWarszawa ")).toBe("m.st. warszawa");
    expect(normalizeCounty("Bielsko-Biała")).toBe("bielsko-biała");
  });

  it("keeps a name that only starts like the prefix", () => {
    expect(normalizeCounty("powiatowy")).toBe("powiatowy");
  });

  it("returns null for empty, prefix-only, overlong or malformed input (no dictionary, no guess)", () => {
    expect(normalizeCounty("")).toBeNull();
    expect(normalizeCounty("  ")).toBeNull();
    expect(normalizeCounty("powiat ")).toBeNull();
    expect(normalizeCounty("pow.")).toBeNull();
    expect(normalizeCounty("x".repeat(101))).toBeNull();
    expect(normalizeCounty("powiat \ud800")).toBeNull();
  });
});

describe("mvpCategoriesForCpv", () => {
  it("maps CPV codes by prefix to sorted, unique MVP categories", () => {
    expect(mvpCategoriesForCpv(["45310000-3"])).toEqual(["elektryka"]);
    expect(mvpCategoriesForCpv(["45331000-6", "45350000-5"])).toEqual(["instalacje"]);
    expect(mvpCategoriesForCpv(["80500000-9", "80400000-8"])).toEqual(["szkolenia"]);
    expect(mvpCategoriesForCpv(["90910000-9", "90610000-6"])).toEqual(["sprzatanie"]);
    expect(mvpCategoriesForCpv(["72000000-5", "48000000-8", "30200000-1"])).toEqual(["it"]);
    expect(mvpCategoriesForCpv(["45453000-7"])).toEqual(["remonty"]);
    expect(mvpCategoriesForCpv(["39100000-3", "39200000-4"])).toEqual(["wyposazenie"]);
    expect(mvpCategoriesForCpv(["18100000-0"])).toEqual(["bhp"]);
  });

  it("gives one code several categories when several prefixes match", () => {
    // Fire alarm installation: electrical work and fire protection.
    expect(mvpCategoriesForCpv(["45312100-8"])).toEqual(["elektryka", "ppoz"]);
    // Repair of fire-fighting equipment: fire protection and servicing.
    expect(mvpCategoriesForCpv(["50413200-5"])).toEqual(["ppoz", "serwis"]);
    // Repair of computers: IT and servicing.
    expect(mvpCategoriesForCpv(["50312000-5"])).toEqual(["it", "serwis"]);
    // OHS and fire safety consulting.
    expect(mvpCategoriesForCpv(["71317200-5", "71317100-4"])).toEqual(["bhp", "ppoz"]);
  });

  it("returns each category once, in alphabetical order, whatever the input order", () => {
    const result = mvpCategoriesForCpv(["50000000-5", "45310000-3", "45310000-3", "18100000-0"]);
    expect(result).toEqual(["bhp", "elektryka", "serwis"]);
    expect([...MVP_CATEGORIES]).toEqual([...MVP_CATEGORIES].sort());
  });

  it("maps only the parent building installation work (4530) to instalacje", () => {
    expect(mvpCategoriesForCpv(["45300000-0"])).toEqual(["instalacje"]);
    // Insulation work (4532) and broader construction (45, 452) stay unmapped.
    expect(mvpCategoriesForCpv(["45320000-6", "45000000-7", "45200000-9"])).toEqual([]);
  });

  it("maps public lighting and traffic signal maintenance (50232) to elektryka, still also serwis", () => {
    expect(mvpCategoriesForCpv(["50232100-1"])).toEqual(["elektryka", "serwis"]);
  });

  it("does not map electricity supply (0931) to electrical work", () => {
    expect(mvpCategoriesForCpv(["09310000-5"])).toEqual([]);
  });

  it("returns [] for unknown codes and ignores anything that is not an 8-digit CPV code", () => {
    expect(mvpCategoriesForCpv([])).toEqual([]);
    // Captured fixture codes: toys, food, shelter services.
    expect(mvpCategoriesForCpv(["37520000-9", "15000000-8", "85311000-2"])).toEqual([]);
    for (const value of [
      "45310000",
      "4531000-3",
      "45310000-33",
      " 45310000-3",
      "45310000-3 Roboty",
      "elektryka",
      "",
      "４５３１００００-３",
    ]) {
      expect(mvpCategoriesForCpv([value]), value).toEqual([]);
    }
  });
});

describe("comparableText format characters (PR-04)", () => {
  it("drops the soft hyphen inside a word, so the word stays one word", () => {
    expect(comparableText("oświe\u00adtlenie")).toBe("oswietlenie");
    expect(comparableText("OŚWIE\u00adTLENIE ulic")).toBe("oswietlenie ulic");
  });

  it("drops zero-width, bidi and BOM characters without a trace", () => {
    expect(comparableText("\ufeffre\u200bmont\u200e da\u2060chu\u202e")).toBe("remont dachu");
  });

  it("is linear on a long run of format characters", () => {
    const hostile = `a${"\u00ad".repeat(200_000)}b`;
    const started = performance.now();
    expect(comparableText(hostile)).toBe("ab");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

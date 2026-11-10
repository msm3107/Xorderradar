import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, MVP_CATEGORIES } from "../src/domain/vocabulary.js";
import {
  correctableInForm,
  FIELD_ORDER,
  formValuesFromStored,
  formValuesFromSubmission,
  REGION_ALL,
  REGION_ERRORS,
  REGION_SELECTED,
  validateProfileForm,
  type ProfileFormValues,
} from "../src/web/profile-form.js";

/*
 * PR-06B: the profile form's validation with the domain schema and its
 * Polish messages. PR-13: no counties field, the explicit region radio.
 * Pure; pseudonymised data only.
 */

const CURRENT = "kontakt@example.invalid";

function values(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return {
    name: "Jan Kowalski Elektryka",
    email: CURRENT,
    categories: ["elektryka"],
    region: REGION_SELECTED,
    voivodeships: ["mazowieckie"],
    includeKeywords: "oświetlenie",
    excludeKeywords: "",
    ...overrides,
  };
}

function errorsOf(input: ProfileFormValues) {
  const result = validateProfileForm(input);
  if (result.ok) throw new Error("expected the form to be invalid");
  return result.errors;
}

describe("validateProfileForm", () => {
  it("returns the schema's normalized settings for a valid form", () => {
    const result = validateProfileForm(
      values({
        name: "  Jan Kowalski  ",
        includeKeywords: "oświetlenie\n\n  latarnie uliczne  \n",
        excludeKeywords: "dostawa paliwa",
      }),
    );
    expect(result).toEqual({
      ok: true,
      settings: {
        name: "Jan Kowalski",
        email: CURRENT,
        categories: ["elektryka"],
        voivodeships: ["mazowieckie"],
        includeKeywords: ["oświetlenie", "latarnie uliczne"],
        excludeKeywords: ["dostawa paliwa"],
      },
    });
  });

  it("accepts empty region and keyword lists (no restriction)", () => {
    const result = validateProfileForm(
      values({ region: REGION_ALL, voivodeships: [], includeKeywords: "" }),
    );
    expect(result.ok).toBe(true);
  });

  it("maps every schema issue to a Polish message on its field", () => {
    expect(errorsOf(values({ name: "   " }))).toEqual({ name: ["Podaj nazwę firmy."] });
    expect(errorsOf(values({ name: "x".repeat(201) }))).toEqual({
      name: ["Nazwa firmy może mieć najwyżej 200 znaków."],
    });
    expect(errorsOf(values({ name: "Firma \uD800" }))).toEqual({
      name: ["Nazwa firmy zawiera niedozwolone znaki."],
    });
    expect(errorsOf(values({ email: "nie-adres" }))).toEqual({
      email: ["Podaj poprawny adres e-mail, na przykład nazwa@firma.pl."],
    });
    expect(errorsOf(values({ categories: [] }))).toEqual({
      categories: ["Wybierz co najmniej jedną kategorię."],
    });
    expect(errorsOf(values({ categories: ["elektryka", "paliwo"] }))).toEqual({
      categories: ["Wybierz kategorie z listy."],
    });
    expect(errorsOf(values({ voivodeships: ["Mazowieckie"] }))).toEqual({
      voivodeships: ["Wybierz województwa z listy."],
    });
  });

  it("names the textarea line of a bad entry, counting blank lines", () => {
    expect(errorsOf(values({ includeKeywords: `\n\n${"a".repeat(101)}` }))).toEqual({
      includeKeywords: ["Wiersz 3: najwyżej 100 znaków."],
    });
    expect(errorsOf(values({ excludeKeywords: "paliwo\r\nx\uD800" }))).toEqual({
      excludeKeywords: ["Wiersz 2: wpis zawiera niedozwolone znaki."],
    });
  });

  // The schema's keyword refinements carry English messages that the form
  // tells apart by their text: these pin each one to its Polish message.
  it("pins the keyword refinements to their Polish messages", () => {
    expect(errorsOf(values({ includeKeywords: "oświetlenie\n---" }))).toEqual({
      includeKeywords: ["Wiersz 2: wpis musi zawierać literę lub cyfrę."],
    });
    const elevenWords = Array.from({ length: 11 }, (_, i) => `slowo${String(i)}`).join(" ");
    expect(errorsOf(values({ excludeKeywords: elevenWords }))).toEqual({
      excludeKeywords: ["Wiersz 1: najwyżej 10 słów."],
    });
  });

  it("refuses more than 100 entries in a list", () => {
    const many = Array.from({ length: 101 }, (_, i) => `slowo${String(i)}`).join("\n");
    expect(errorsOf(values({ includeKeywords: many }))).toEqual({
      includeKeywords: ["Wpisz najwyżej 100 słów kluczowych, jedno w wierszu."],
    });
    expect(errorsOf(values({ excludeKeywords: many }))).toEqual({
      excludeKeywords: ["Wpisz najwyżej 100 słów wykluczających, jedno w wierszu."],
    });
  });

  it("refuses control characters (a pasted tab) in the name and in every list entry", () => {
    expect(
      errorsOf(
        values({
          name: "Jan\tKowalski",
          includeKeywords: "oświetlenie\n\nlatarnie\tuliczne",
          excludeKeywords: "paliwo\u0085",
        }),
      ),
    ).toEqual({
      name: ["Nazwa firmy zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie."],
      includeKeywords: [
        "Wiersz 3: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      ],
      excludeKeywords: [
        "Wiersz 1: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      ],
    });
    // A control character only around an entry is trimmed away, as before.
    expect(
      validateProfileForm(values({ name: "\tJan Kowalski\t", includeKeywords: "\toświetlenie" }))
        .ok,
    ).toBe(true);
  });

  it("shows at most five messages per field and counts the rest", () => {
    const bad = (count: number) => Array.from({ length: count }, () => "---").join("\n");
    const six = errorsOf(values({ includeKeywords: bad(6) })).includeKeywords;
    expect(six).toHaveLength(6);
    expect(six?.[4]).toBe("Wiersz 5: wpis musi zawierać literę lub cyfrę.");
    expect(six?.[5]).toBe("Oraz 1 inny błąd w tym polu.");
    expect(errorsOf(values({ includeKeywords: bad(7) })).includeKeywords?.[5]).toBe(
      "Oraz 2 inne błędy w tym polu.",
    );
    expect(errorsOf(values({ includeKeywords: bad(10) })).includeKeywords?.[5]).toBe(
      "Oraz 5 innych błędów w tym polu.",
    );
  });

  it("lists the errors of several fields in the order of the form", () => {
    const errors = errorsOf(
      values({ excludeKeywords: "---", name: "", categories: [], voivodeships: ["x"] }),
    );
    expect(Object.keys(errors)).toEqual(["name", "categories", "voivodeships", "excludeKeywords"]);
    expect(FIELD_ORDER.filter((field) => field in errors)).toEqual(Object.keys(errors));
  });

  // PR-13: the region is an explicit choice; a choice contradicting the boxes is refused.
  describe("the region radio", () => {
    it("saves the whole country with no voivodeship and the ticked ones otherwise", () => {
      const all = validateProfileForm(values({ region: REGION_ALL, voivodeships: [] }));
      if (!all.ok) throw new Error("expected the form to be valid");
      expect(all.settings.voivodeships).toEqual([]);
      const selected = validateProfileForm(
        values({ region: REGION_SELECTED, voivodeships: ["opolskie", "mazowieckie"] }),
      );
      if (!selected.ok) throw new Error("expected the form to be valid");
      expect(selected.settings.voivodeships).toEqual(["opolskie", "mazowieckie"]);
    });

    it("refuses „Wybrane województwa” with none ticked", () => {
      expect(errorsOf(values({ region: REGION_SELECTED, voivodeships: [] }))).toEqual({
        voivodeships: ["Zaznacz co najmniej jedno województwo albo wybierz „Cała Polska”."],
      });
    });

    it("refuses „Cała Polska” with voivodeships ticked, instead of ignoring them", () => {
      expect(errorsOf(values({ region: REGION_ALL, voivodeships: ["mazowieckie"] }))).toEqual({
        voivodeships: [
          "Zaznaczono „Cała Polska” i województwa. Wybierz „Wybrane województwa” albo " +
            "odznacz województwa.",
        ],
      });
    });

    it("refuses an unknown choice whatever is ticked", () => {
      for (const region of ["", "ALL", "wszystkie", " all", "selected\n"]) {
        for (const voivodeships of [[], ["mazowieckie"]]) {
          expect(errorsOf(values({ region, voivodeships }))).toEqual({
            voivodeships: [REGION_ERRORS.unknown],
          });
        }
      }
      expect(REGION_ERRORS.unknown).toBe("Wybierz „Cała Polska” albo „Wybrane województwa”.");
    });

    it("adds its message after the schema's for an unknown voivodeship", () => {
      expect(errorsOf(values({ region: REGION_ALL, voivodeships: ["Mazowieckie"] }))).toEqual({
        voivodeships: ["Wybierz województwa z listy.", REGION_ERRORS.allWithTicked],
      });
    });
  });

  it("never carries counties: the form leaves the stored ones alone (PR-13)", () => {
    const result = validateProfileForm(values());
    if (!result.ok) throw new Error("expected the form to be valid");
    expect(Object.keys(result.settings).sort()).toEqual(
      ["categories", "email", "excludeKeywords", "includeKeywords", "name", "voivodeships"].sort(),
    );
    expect(FIELD_ORDER).toEqual([
      "name",
      "email",
      "categories",
      "voivodeships",
      "includeKeywords",
      "excludeKeywords",
    ]);
  });

  // D-031: a new address is confirmed by the link sent to it, not by typing it twice.
  describe("a new e-mail address", () => {
    it("is accepted alone, normalized like the stored one", () => {
      const result = validateProfileForm(values({ email: "  BIURO@example.invalid " }));
      if (!result.ok) throw new Error("expected the form to be valid");
      expect(result.settings.email).toBe("biuro@example.invalid");
    });

    it("gets only its own message while it is invalid", () => {
      expect(errorsOf(values({ email: "biuro@", name: "" }))).toEqual({
        name: ["Podaj nazwę firmy."],
        email: ["Podaj poprawny adres e-mail, na przykład nazwa@firma.pl."],
      });
    });
  });
});

// PR-13: a stored profile refused at a field the form does not rewrite needs the operator.
describe("correctableInForm", () => {
  it("is true only when every refused path is a field a save rewrites", () => {
    expect(correctableInForm(["name"])).toBe(true);
    expect(correctableInForm(["categories", "includeKeywords.0", "excludeKeywords.3"])).toBe(true);
    expect(correctableInForm(["voivodeships.1"])).toBe(true);
    expect(correctableInForm(["counties"])).toBe(false);
    expect(correctableInForm(["counties.0"])).toBe(false);
    expect(correctableInForm(["includeKeywords.0", "counties.100"])).toBe(false);
    // A refused stored address stays: a new one only waits as pending.
    expect(correctableInForm(["email"])).toBe(false);
    expect(correctableInForm(["active"])).toBe(false);
    expect(correctableInForm(["(root)"])).toBe(false);
    expect(correctableInForm(["nameX"])).toBe(false);
    expect(correctableInForm([])).toBe(false);
  });
});

describe("form values", () => {
  it("show the stored lists one per line", () => {
    expect(
      formValuesFromStored({
        name: "Jan Kowalski",
        email: CURRENT,
        categories: ["elektryka", "it"],
        voivodeships: [],
        counties: ["warszawski zachodni", "piaseczyński"],
        includeKeywords: ["oświetlenie"],
        excludeKeywords: [],
      }),
    ).toEqual({
      name: "Jan Kowalski",
      email: CURRENT,
      categories: ["elektryka", "it"],
      region: REGION_ALL,
      voivodeships: [],
      includeKeywords: "oświetlenie",
      excludeKeywords: "",
    });
  });

  it("pre-select „Wybrane województwa” when the profile names voivodeships", () => {
    const stored = {
      name: "Jan Kowalski",
      email: CURRENT,
      categories: ["elektryka"],
      voivodeships: ["opolskie"],
      counties: [],
      includeKeywords: [],
      excludeKeywords: [],
    };
    expect(formValuesFromStored(stored).region).toBe(REGION_SELECTED);
    expect(formValuesFromStored({ ...stored, voivodeships: [] }).region).toBe(REGION_ALL);
    // Counties set by the operator do not change the choice (they are not on the form).
    expect(
      formValuesFromStored({ ...stored, voivodeships: [], counties: ["piaseczyński"] }).region,
    ).toBe(REGION_ALL);
  });

  it("take the submitted fields by their form names", () => {
    expect(
      formValuesFromSubmission(
        {
          csrf: "c",
          name: "n",
          email: "e",
          region: "r",
          include_keywords: "ik",
          exclude_keywords: "ek",
        },
        { categories: ["it"], voivodeships: ["opolskie"] },
      ),
    ).toEqual({
      name: "n",
      email: "e",
      categories: ["it"],
      region: "r",
      voivodeships: ["opolskie"],
      includeKeywords: "ik",
      excludeKeywords: "ek",
    });
  });

  it("label every MVP category in Polish", () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...MVP_CATEGORIES].sort());
  });
});

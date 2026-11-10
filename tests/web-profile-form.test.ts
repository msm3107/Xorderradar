import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, MVP_CATEGORIES } from "../src/domain/vocabulary.js";
import {
  FIELD_ORDER,
  formValuesFromStored,
  formValuesFromSubmission,
  validateProfileForm,
  type ProfileFormValues,
} from "../src/web/profile-form.js";

/*
 * PR-06B: the profile form's validation with the domain schema and its
 * Polish messages. Pure; pseudonymised data only.
 */

const CURRENT = "kontakt@example.invalid";

function values(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return {
    name: "Jan Kowalski Elektryka",
    email: CURRENT,
    emailConfirm: "",
    categories: ["elektryka"],
    voivodeships: ["mazowieckie"],
    counties: "",
    includeKeywords: "oświetlenie",
    excludeKeywords: "",
    ...overrides,
  };
}

function errorsOf(input: ProfileFormValues, current = CURRENT) {
  const result = validateProfileForm(input, current);
  if (result.ok) throw new Error("expected the form to be invalid");
  return result.errors;
}

describe("validateProfileForm", () => {
  it("returns the schema's normalized settings for a valid form", () => {
    const result = validateProfileForm(
      values({
        name: "  Jan Kowalski  ",
        counties: "\r\n  warszawski zachodni \r\n\r\npiaseczyński",
        includeKeywords: "oświetlenie\n\n  latarnie uliczne  \n",
        excludeKeywords: "dostawa paliwa",
      }),
      CURRENT,
    );
    expect(result).toEqual({
      ok: true,
      settings: {
        name: "Jan Kowalski",
        email: CURRENT,
        categories: ["elektryka"],
        voivodeships: ["mazowieckie"],
        counties: ["warszawski zachodni", "piaseczyński"],
        includeKeywords: ["oświetlenie", "latarnie uliczne"],
        excludeKeywords: ["dostawa paliwa"],
      },
    });
  });

  it("accepts empty region and keyword lists (no restriction)", () => {
    const result = validateProfileForm(
      values({ voivodeships: [], counties: " \n ", includeKeywords: "" }),
      CURRENT,
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
    expect(errorsOf(values({ counties: `\n\n${"a".repeat(101)}` }))).toEqual({
      counties: ["Wiersz 3: najwyżej 100 znaków."],
    });
    expect(errorsOf(values({ counties: "warszawski\r\nx\uD800" }))).toEqual({
      counties: ["Wiersz 2: wpis zawiera niedozwolone znaki."],
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
    expect(errorsOf(values({ counties: many }))).toEqual({
      counties: ["Wpisz najwyżej 100 powiatów, każdy w osobnym wierszu."],
    });
  });

  it("refuses a county entry that is no county name, as profile:create does", () => {
    expect(
      errorsOf(values({ counties: "warszawski zachodni\n\npowiat\nm. st.\nPOWIAT " })),
    ).toEqual({
      counties: [
        "Wiersz 3: wpisz nazwę powiatu, np. warszawski zachodni.",
        "Wiersz 4: wpisz nazwę powiatu, np. warszawski zachodni.",
        "Wiersz 5: wpisz nazwę powiatu, np. warszawski zachodni.",
      ],
    });
    // Names in their usual spellings stay accepted.
    const accepted = validateProfileForm(
      values({
        counties: "m. st. Warszawa\npowiat piaseczyński\nKraków (miasto na prawach powiatu)",
      }),
      CURRENT,
    );
    expect(accepted.ok).toBe(true);
    // An entry the schema already refuses gets the schema's message only.
    expect(errorsOf(values({ counties: "powiat\uD800" }))).toEqual({
      counties: ["Wiersz 1: wpis zawiera niedozwolone znaki."],
    });
  });

  it("refuses control characters (a pasted tab) in the name and in every list entry", () => {
    expect(
      errorsOf(
        values({
          name: "Jan\tKowalski",
          counties: "warszawski zachodni\npiase\u0000czyński",
          includeKeywords: "oświetlenie\n\nlatarnie\tuliczne",
          excludeKeywords: "paliwo\u0085",
        }),
      ),
    ).toEqual({
      name: ["Nazwa firmy zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie."],
      counties: [
        "Wiersz 2: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      ],
      includeKeywords: [
        "Wiersz 3: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      ],
      excludeKeywords: [
        "Wiersz 1: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      ],
    });
    // A control character only around an entry is trimmed away, as before.
    expect(
      validateProfileForm(
        values({ name: "\tJan Kowalski\t", includeKeywords: "\toświetlenie" }),
        CURRENT,
      ).ok,
    ).toBe(true);
    // An entry that is only a control character gets one message, not also the county one.
    expect(errorsOf(values({ counties: "\u0001" }))).toEqual({
      counties: [
        "Wiersz 1: wpis zawiera znaki sterujące (np. tabulator) — wpisz wartość ponownie.",
      ],
    });
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
      values({ excludeKeywords: "---", name: "", categories: [], counties: "a".repeat(101) }),
    );
    expect(Object.keys(errors)).toEqual(["name", "categories", "counties", "excludeKeywords"]);
    expect(FIELD_ORDER.filter((field) => field in errors)).toEqual(Object.keys(errors));
  });

  describe("the e-mail confirmation", () => {
    const next = "biuro@example.invalid";

    it("is not needed while the address stays the same (after normalization)", () => {
      expect(validateProfileForm(values({ email: ` ${CURRENT.toUpperCase()} ` }), CURRENT)).toEqual(
        expect.objectContaining({ ok: true }),
      );
    });

    it("must repeat a new address", () => {
      expect(errorsOf(values({ email: next }))).toEqual({
        emailConfirm: ["Wpisz nowy adres e-mail jeszcze raz."],
      });
      expect(errorsOf(values({ email: next, emailConfirm: "biuro@example.invalid.pl" }))).toEqual({
        emailConfirm: ["Adresy e-mail różnią się. Wpisz nowy adres dwa razy tak samo."],
      });
    });

    it("is compared after normalization", () => {
      const result = validateProfileForm(
        values({ email: next, emailConfirm: "  BIURO@example.invalid " }),
        CURRENT,
      );
      if (!result.ok) throw new Error("expected the form to be valid");
      expect(result.settings.email).toBe(next);
    });

    it("is checked even when another field is invalid", () => {
      expect(errorsOf(values({ email: next, name: "" }))).toEqual({
        name: ["Podaj nazwę firmy."],
        emailConfirm: ["Wpisz nowy adres e-mail jeszcze raz."],
      });
    });

    it("is not asked for while the new address itself is invalid", () => {
      expect(errorsOf(values({ email: "biuro@" }))).toEqual({
        email: ["Podaj poprawny adres e-mail, na przykład nazwa@firma.pl."],
      });
    });
  });
});

describe("form values", () => {
  it("show the stored lists one per line, with an empty confirmation", () => {
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
      emailConfirm: "",
      categories: ["elektryka", "it"],
      voivodeships: [],
      counties: "warszawski zachodni\npiaseczyński",
      includeKeywords: "oświetlenie",
      excludeKeywords: "",
    });
  });

  it("take the submitted fields by their form names", () => {
    expect(
      formValuesFromSubmission(
        {
          csrf: "c",
          name: "n",
          email: "e",
          email_confirm: "ec",
          counties: "co",
          include_keywords: "ik",
          exclude_keywords: "ek",
        },
        { categories: ["it"], voivodeships: ["opolskie"] },
      ),
    ).toEqual({
      name: "n",
      email: "e",
      emailConfirm: "ec",
      categories: ["it"],
      voivodeships: ["opolskie"],
      counties: "co",
      includeKeywords: "ik",
      excludeKeywords: "ek",
    });
  });

  it("label every MVP category in Polish", () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...MVP_CATEGORIES].sort());
  });
});

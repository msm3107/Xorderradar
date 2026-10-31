import { describe, expect, it } from "vitest";
import { httpUrlSchema, parseDomain } from "../src/domain/common.js";
import {
  companyProfileInputSchema,
  companyProfilePatchSchema,
} from "../src/domain/company-profile.js";
import { DomainError } from "../src/domain/errors.js";
import {
  contactSchema,
  decimalAmountSchema,
  locationSchema,
  opportunityDraftSchema,
  type OpportunityDraft,
} from "../src/domain/opportunity.js";
import { sourceInputSchema } from "../src/domain/source.js";

const validDraft: OpportunityDraft = {
  sourceId: "baza-konkurencyjnosci",
  sourceUrl: "https://bazakonkurencyjnosci.example.gov.pl/ogloszenie/1",
  externalId: null,
  tenderId: null,
  issuerName: "Gmina Przykładowa",
  title: "Remont dachu świetlicy",
  description: null,
  location: null,
  publishedAt: null,
  deadline: null,
  estimatedValue: null,
  currency: null,
  categories: [],
  contact: null,
  fetchedAt: new Date("2026-10-01T08:00:00.000Z"),
  fingerprint: "fp-1",
  contentHash: "hash-1",
  status: "unknown",
};

function invalidFields(schema: Parameters<typeof parseDomain>[0], value: unknown): string[] {
  try {
    parseDomain(schema, value);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_input");
    return [...(error as DomainError).fields];
  }
  throw new Error("expected the value to be rejected");
}

describe("opportunity draft schema", () => {
  it("accepts a draft where every optional value is null", () => {
    expect(parseDomain(opportunityDraftSchema, validDraft)).toEqual(validDraft);
  });

  it("requires every field to be present: missing is null, not absent", () => {
    const withoutValue: Partial<OpportunityDraft> = { ...validDraft };
    delete withoutValue.estimatedValue;
    expect(invalidFields(opportunityDraftSchema, withoutValue)).toEqual(["estimatedValue"]);
  });

  it("rejects empty strings instead of storing them as values", () => {
    expect(
      invalidFields(opportunityDraftSchema, { ...validDraft, description: "   ", externalId: "" }),
    ).toEqual(["externalId", "description"]);
  });

  it("trims text fields", () => {
    const parsed = parseDomain(opportunityDraftSchema, { ...validDraft, title: "  Remont  " });
    expect(parsed.title).toBe("Remont");
  });

  it("requires currency exactly when an estimated value is present", () => {
    expect(invalidFields(opportunityDraftSchema, { ...validDraft, estimatedValue: "100" })).toEqual(
      ["currency"],
    );
    expect(invalidFields(opportunityDraftSchema, { ...validDraft, currency: "PLN" })).toEqual([
      "currency",
    ]);
    expect(
      parseDomain(opportunityDraftSchema, {
        ...validDraft,
        estimatedValue: "100",
        currency: "PLN",
      }),
    ).toMatchObject({ estimatedValue: "100", currency: "PLN" });
  });

  it.each(["0", "12500", "12500.5", "12500.50", "999999999999999.9999"])(
    "accepts the amount %s",
    (amount) => {
      expect(decimalAmountSchema.safeParse(amount).success).toBe(true);
    },
  );

  it.each(["-1", "1e5", "01", "1,5", "1.", ".5", "12500.12345", "", " 1", "NaN"])(
    "rejects the amount %j",
    (amount) => {
      expect(decimalAmountSchema.safeParse(amount).success).toBe(false);
    },
  );

  it("does not accept a number for the amount (no float money)", () => {
    expect(
      invalidFields(opportunityDraftSchema, {
        ...validDraft,
        estimatedValue: 100,
        currency: "PLN",
      }),
    ).toEqual(["estimatedValue"]);
  });

  it.each(["pln", "PL", "PLNN", "zł"])("rejects the currency %j", (currency) => {
    expect(
      invalidFields(opportunityDraftSchema, { ...validDraft, estimatedValue: "1", currency }),
    ).toEqual(["currency"]);
  });

  it("only accepts the known statuses", () => {
    for (const status of ["open", "closed", "cancelled", "unknown"]) {
      expect(opportunityDraftSchema.safeParse({ ...validDraft, status }).success).toBe(true);
    }
    expect(invalidFields(opportunityDraftSchema, { ...validDraft, status: "archived" })).toEqual([
      "status",
    ]);
  });

  it("rejects invalid dates", () => {
    expect(
      invalidFields(opportunityDraftSchema, { ...validDraft, deadline: new Date("not a date") }),
    ).toEqual(["deadline"]);
  });

  it("rejects unknown fields", () => {
    expect(invalidFields(opportunityDraftSchema, { ...validDraft, score: 1 })).toEqual(["(root)"]);
  });

  it("bounds list and text sizes", () => {
    expect(
      invalidFields(opportunityDraftSchema, {
        ...validDraft,
        title: "x".repeat(1001),
        categories: Array.from({ length: 101 }, (_, i) => `c${String(i)}`),
      }),
    ).toEqual(["title", "categories"]);
  });
});

describe("well-formed Unicode", () => {
  const lone = "\ud800"; // an unpaired surrogate half

  it("rejects lone surrogates in text, list items and jsonb object strings", () => {
    expect(
      invalidFields(opportunityDraftSchema, {
        ...validDraft,
        title: `Remont${lone}`,
        categories: ["elektryka", `bhp${lone}`],
        location: { city: `Łódź${lone}` },
      }).sort(),
    ).toEqual(["categories.1", "location.city", "title"]);
  });

  it("accepts valid surrogate pairs (e.g. emoji) and Polish letters", () => {
    expect(
      parseDomain(opportunityDraftSchema, { ...validDraft, title: "Zażółć gęślą jaźń 😀" }).title,
    ).toBe("Zażółć gęślą jaźń 😀");
  });

  it("applies to company profiles too", () => {
    expect(
      companyProfileInputSchema.safeParse({
        email: "a@b.pl",
        name: `Firma${lone}`,
        categories: ["elektryka"],
        includeKeywords: [`klucz${lone}`],
        excludeKeywords: [],
        voivodeships: [],
        counties: [],
        active: true,
      }).success,
    ).toBe(false);
  });
});

describe("location and contact", () => {
  it("accept partial objects with only the published parts", () => {
    expect(locationSchema.parse({ city: "Łódź" })).toEqual({ city: "Łódź" });
    expect(contactSchema.parse({ email: " Zamowienia@Example.GOV.pl " })).toEqual({
      email: "zamowienia@example.gov.pl",
    });
  });

  it("reject an empty object (use null when nothing is known)", () => {
    expect(locationSchema.safeParse({}).success).toBe(false);
    expect(contactSchema.safeParse({}).success).toBe(false);
  });

  it("reject unknown fields and over-long values", () => {
    expect(locationSchema.safeParse({ city: "Łódź", gps: "51,19" }).success).toBe(false);
    expect(contactSchema.safeParse({ phone: "1".repeat(51) }).success).toBe(false);
    expect(contactSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });
});

describe("URLs", () => {
  it.each(["https://bip.example.gov.pl/a?b=1", "http://bip.example.gov.pl"])(
    "accepts %s",
    (url) => {
      expect(httpUrlSchema.safeParse(url).success).toBe(true);
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.gov.pl/file",
    "https://user:pass@example.gov.pl/",
    "/relative/path",
    `https://example.gov.pl/${"a".repeat(2048)}`,
    // Whitespace and control characters inside the URL are rejected, not encoded.
    "https://a.example/a b",
    "https://a.example/a\nb",
    "https://a.example/a b\n<script>",
    "https://a.example/a\tb",
    "https://a.example/a\rb",
    "https://a.example/a\u0000b",
    "https://a.example/a\u007fb",
    "https://a.example/a\u00a0b", // non-breaking space (\s)
    "https://a.example/\ud800", // lone surrogate
  ])("rejects %j", (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  });

  it("stores the canonical href, not the raw input", () => {
    expect(httpUrlSchema.parse("  HTTPS://BIP.Example.GOV.pl/Zamowienia?id=1#top ")).toBe(
      "https://bip.example.gov.pl/Zamowienia?id=1#top",
    );
    expect(httpUrlSchema.parse("http://bip.example.gov.pl")).toBe("http://bip.example.gov.pl/");
    expect(httpUrlSchema.parse("https://bip.example.gov.pl/a/../b")).toBe(
      "https://bip.example.gov.pl/b",
    );
  });

  it("percent-encodes characters such as < so they are never stored raw", () => {
    const href = httpUrlSchema.parse("https://a.example/<x>?q=<y>#<z>");
    expect(href).toBe("https://a.example/%3Cx%3E?q=%3Cy%3E#%3Cz%3E");
    expect(href).not.toMatch(/[<>]/);
  });

  it("applies the length limit to the canonical form too", () => {
    // 1000 × "ż" is < 2048 characters as input but 6000+ once percent-encoded.
    const input = `https://a.example/${"ż".repeat(1000)}`;
    expect(input.length).toBeLessThanOrEqual(2048);
    expect(httpUrlSchema.safeParse(input).success).toBe(false);
    // Just under the limit after encoding is still accepted.
    const fits = `https://a.example/${"a".repeat(2048 - "https://a.example/".length)}`;
    expect(httpUrlSchema.parse(fits)).toHaveLength(2048);
  });

  it("canonicalizes both source.baseUrl and opportunity.sourceUrl", () => {
    expect(
      sourceInputSchema.parse({
        id: "bip",
        name: "BIP",
        baseUrl: "HTTPS://BIP.Example.pl",
        enabled: true,
      }).baseUrl,
    ).toBe("https://bip.example.pl/");
    expect(
      parseDomain(opportunityDraftSchema, { ...validDraft, sourceUrl: "https://A.Example/x" })
        .sourceUrl,
    ).toBe("https://a.example/x");
    expect(
      invalidFields(opportunityDraftSchema, { ...validDraft, sourceUrl: "https://a.example/a b" }),
    ).toEqual(["sourceUrl"]);
  });
});

describe("source schema", () => {
  it("accepts a stable lower-case id", () => {
    expect(
      sourceInputSchema.safeParse({
        id: "baza-konkurencyjnosci",
        name: "Baza Konkurencyjności",
        baseUrl: "https://bazakonkurencyjnosci.example.gov.pl",
        enabled: true,
      }).success,
    ).toBe(true);
  });

  it.each(["Baza", "baza konkurencyjnosci", "-baza", "baza--x", "baza_x", ""])(
    "rejects the id %j",
    (id) => {
      expect(
        sourceInputSchema.safeParse({ id, name: "x", baseUrl: "https://x.pl", enabled: true })
          .success,
      ).toBe(false);
    },
  );
});

describe("company profile schema", () => {
  const validProfile = {
    email: "  Biuro@Firma.PL ",
    name: "Firma",
    categories: ["elektryka"],
    includeKeywords: [],
    excludeKeywords: [],
    voivodeships: [],
    counties: [],
    active: true,
  };

  it("normalizes the e-mail (trim + lower case)", () => {
    expect(parseDomain(companyProfileInputSchema, validProfile).email).toBe("biuro@firma.pl");
  });

  it("requires every field on create (no hidden defaults)", () => {
    const withoutActive: Partial<typeof validProfile> = { ...validProfile };
    delete withoutActive.active;
    expect(invalidFields(companyProfileInputSchema, withoutActive)).toEqual(["active"]);
  });

  it("rejects an invalid e-mail without echoing it", () => {
    let message = "";
    try {
      parseDomain(companyProfileInputSchema, { ...validProfile, email: "secret-person@" });
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toContain("email");
    expect(message).not.toContain("secret-person");
  });

  it("patch accepts a subset of fields but not an empty object", () => {
    expect(parseDomain(companyProfilePatchSchema, { active: false })).toEqual({ active: false });
    expect(invalidFields(companyProfilePatchSchema, {})).toEqual(["(root)"]);
    // A key set to undefined changes nothing, so it does not count as a field.
    expect(invalidFields(companyProfilePatchSchema, { email: undefined })).toEqual(["(root)"]);
    expect(
      invalidFields(companyProfilePatchSchema, { email: undefined, active: undefined }),
    ).toEqual(["(root)"]);
  });
});

describe("company profile preferences (PR-04, D-023)", () => {
  const profile = {
    email: "kontakt@example.invalid",
    name: "Jan Kowalski Usługi",
    categories: ["elektryka"],
    includeKeywords: ["oświetlenie"],
    excludeKeywords: [],
    voivodeships: ["mazowieckie"],
    counties: ["piaseczyński"],
    active: true,
  };

  it("accepts MVP categories and canonical voivodeship names", () => {
    const parsed = parseDomain(companyProfileInputSchema, {
      ...profile,
      categories: ["elektryka", "ppoz"],
      voivodeships: ["mazowieckie", "śląskie"],
    });
    expect(parsed.categories).toEqual(["elektryka", "ppoz"]);
    expect(parsed.voivodeships).toEqual(["mazowieckie", "śląskie"]);
  });

  it("requires at least one category", () => {
    expect(invalidFields(companyProfileInputSchema, { ...profile, categories: [] })).toEqual([
      "categories",
    ]);
  });

  it("rejects a category outside the MVP list", () => {
    expect(
      invalidFields(companyProfileInputSchema, { ...profile, categories: ["elektryka", "gaz"] }),
    ).toEqual(["categories.1"]);
  });

  it("rejects a voivodeship that is not a canonical name", () => {
    expect(
      invalidFields(companyProfileInputSchema, {
        ...profile,
        voivodeships: ["Mazowieckie", "mazowsze"],
      }),
    ).toEqual(["voivodeships.0", "voivodeships.1"]);
  });

  it("rejects a keyword without any letter or digit", () => {
    expect(
      invalidFields(companyProfileInputSchema, { ...profile, includeKeywords: ["ok", "--"] }),
    ).toEqual(["includeKeywords.1"]);
    expect(
      invalidFields(companyProfileInputSchema, { ...profile, excludeKeywords: ["."] }),
    ).toEqual(["excludeKeywords.0"]);
  });

  it("accepts a keyword of up to 10 words and rejects a longer one", () => {
    const ten = "a b c d e f g h i j";
    const eleven = `${ten} k`;
    expect(
      parseDomain(companyProfileInputSchema, { ...profile, includeKeywords: [ten] })
        .includeKeywords,
    ).toEqual([ten]);
    expect(
      invalidFields(companyProfileInputSchema, { ...profile, includeKeywords: ["ok", eleven] }),
    ).toEqual(["includeKeywords.1"]);
    expect(
      invalidFields(companyProfileInputSchema, { ...profile, excludeKeywords: [eleven] }),
    ).toEqual(["excludeKeywords.0"]);
    // Words as the tokenizer counts them: punctuation separates, a soft hyphen does not.
    expect(
      invalidFields(companyProfileInputSchema, {
        ...profile,
        includeKeywords: ["a-b-c-d-e-f-g-h-i-j-k"],
      }),
    ).toEqual(["includeKeywords.0"]);
    expect(
      parseDomain(companyProfileInputSchema, {
        ...profile,
        includeKeywords: [`${ten}\u00adk`],
      }).includeKeywords,
    ).toHaveLength(1);
    expect(invalidFields(companyProfilePatchSchema, { excludeKeywords: [eleven] })).toEqual([
      "excludeKeywords.0",
    ]);
  });

  it("applies the same rules to a patch", () => {
    expect(invalidFields(companyProfilePatchSchema, { categories: [] })).toEqual(["categories"]);
    expect(invalidFields(companyProfilePatchSchema, { voivodeships: ["Śląsk"] })).toEqual([
      "voivodeships.0",
    ]);
  });
});

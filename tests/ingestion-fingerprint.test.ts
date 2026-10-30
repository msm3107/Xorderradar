import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  opportunityCandidateSchema,
  type OpportunityCandidate,
} from "../src/domain/opportunity.js";
import { contentHash, fingerprint } from "../src/ingestion/fingerprint.js";

function candidate(overrides: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return opportunityCandidateSchema.parse({
    sourceId: "bzp",
    sourceUrl: "https://ezamowienia.gov.pl/notice/1",
    externalId: "2026/BZP 00000001/01",
    tenderId: "ocds-148610-00000000-0000-4000-8000-000000000001",
    issuerName: "Gmina Przykładowa",
    title: "Remont drogi gminnej",
    description: "Opis zamówienia",
    location: { city: "Przykładowo", voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-10-29T08:00:00.000Z"),
    deadline: new Date("2026-11-12T09:00:00.000Z"),
    estimatedValue: "125000.00",
    currency: "PLN",
    categories: ["45233142-6"],
    contact: { name: "Jan Kowalski", email: "kontakt@example.invalid", phone: "000 000 000" },
    fetchedAt: new Date("2026-10-30T06:00:00.000Z"),
    status: "open",
    ...overrides,
  });
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

describe("fingerprint", () => {
  it("is a SHA-256 hex digest of the source and its own id", () => {
    const value = fingerprint(candidate());
    expect(value).toMatch(HEX_SHA256);
    expect(value).toBe(fingerprint(candidate({ title: "Inny tytuł", sourceUrl: "https://x.pl/" })));
  });

  it("depends on the source and the external id", () => {
    const base = fingerprint(candidate());
    expect(fingerprint(candidate({ externalId: "2026/BZP 00000002/01" }))).not.toBe(base);
    expect(fingerprint({ ...candidate(), sourceId: "inne-zrodlo" })).not.toBe(base);
  });

  it("does not depend on the tender id (a procedure has several notices)", () => {
    const base = fingerprint(candidate());
    expect(fingerprint(candidate({ tenderId: null }))).toBe(base);
    expect(
      fingerprint(candidate({ tenderId: "ocds-148610-00000000-0000-4000-8000-000000000002" })),
    ).toBe(base);
  });

  it("falls back to the source URL when the notice has no external id", () => {
    const withoutId = candidate({ externalId: null });
    const value = fingerprint(withoutId);
    expect(value).toMatch(HEX_SHA256);
    expect(value).not.toBe(fingerprint(candidate()));
    expect(
      fingerprint({ ...withoutId, sourceUrl: "https://ezamowienia.gov.pl/notice/2" }),
    ).not.toBe(value);
  });

  it("never confuses an external id with a URL of the same text", () => {
    const url = "https://ezamowienia.gov.pl/notice/1";
    expect(fingerprint({ sourceId: "bzp", externalId: url, sourceUrl: url })).not.toBe(
      fingerprint({ sourceId: "bzp", externalId: null, sourceUrl: url }),
    );
  });

  it("has no ambiguous separator between the parts", () => {
    expect(fingerprint({ sourceId: "a", externalId: "b-c", sourceUrl: "https://x.pl/" })).not.toBe(
      fingerprint({ sourceId: "a-b", externalId: "c", sourceUrl: "https://x.pl/" }),
    );
  });
});

describe("contentHash", () => {
  it("is a SHA-256 hex digest, stable for the same content", () => {
    expect(contentHash(candidate())).toMatch(HEX_SHA256);
    expect(contentHash(candidate())).toBe(contentHash(candidate()));
  });

  it("does not depend on key order, at the top level or in nested objects", () => {
    const base = candidate();
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as OpportunityCandidate;
    expect(contentHash(reordered)).toBe(contentHash(base));
    expect(
      contentHash(
        candidate({
          location: { voivodeship: "mazowieckie", city: "Przykładowo" },
          contact: { phone: "000 000 000", email: "kontakt@example.invalid", name: "Jan Kowalski" },
        }),
      ),
    ).toBe(contentHash(base));
  });

  it.each([
    ["deadline", { deadline: new Date("2026-11-13T09:00:00.000Z") }],
    ["title", { title: "Remont drogi powiatowej" }],
    ["estimatedValue", { estimatedValue: "125000.01" }],
    ["issuerName", { issuerName: "Gmina Inna" }],
    ["status", { status: "closed" as const }],
    ["categories", { categories: ["45233142-6", "45000000-7"] }],
    ["location", { location: { city: "Przykładowo" } }],
    ["contact", { contact: { name: "Jan Kowalski" } }],
    ["sourceUrl", { sourceUrl: "https://ezamowienia.gov.pl/notice/9" }],
    ["publishedAt", { publishedAt: new Date("2026-10-29T08:00:00.001Z") }],
    ["tenderId", { tenderId: "ocds-148610-00000000-0000-4000-8000-000000000002" }],
    ["tenderId (to null)", { tenderId: null }],
  ])("changes when %s changes", (_field, overrides) => {
    expect(contentHash(candidate(overrides))).not.toBe(contentHash(candidate()));
  });

  it("hashes the fixed field list in D-016 order, ending with tenderId", () => {
    const value = candidate();
    const pairs = [
      ["issuerName", value.issuerName],
      ["title", value.title],
      ["description", value.description],
      ["location", { city: "Przykładowo", voivodeship: "mazowieckie" }],
      ["publishedAt", "2026-10-29T08:00:00.000Z"],
      ["deadline", "2026-11-12T09:00:00.000Z"],
      ["estimatedValue", value.estimatedValue],
      ["currency", value.currency],
      ["categories", value.categories],
      ["contact", { email: "kontakt@example.invalid", name: "Jan Kowalski", phone: "000 000 000" }],
      ["status", value.status],
      ["sourceUrl", value.sourceUrl],
      ["externalId", value.externalId],
      ["tenderId", value.tenderId],
    ];
    const expected = createHash("sha256").update(JSON.stringify(pairs), "utf8").digest("hex");
    expect(contentHash(value)).toBe(expected);
  });

  it("does not change when only fetchedAt changes (when we looked is not content)", () => {
    expect(contentHash(candidate({ fetchedAt: new Date("2026-11-30T06:00:00.000Z") }))).toBe(
      contentHash(candidate()),
    );
  });

  it("does not include the source id (it is part of the fingerprint)", () => {
    expect(contentHash({ ...candidate(), sourceId: "inne-zrodlo" })).toBe(contentHash(candidate()));
  });

  it("keeps null, empty string and an absent field apart", () => {
    const base = candidate({ description: null });
    const empty = { ...base, description: "" };
    const absent: Partial<OpportunityCandidate> = { ...base };
    delete absent.description;
    const hashes = new Set([
      contentHash(base),
      contentHash(empty),
      contentHash(absent as OpportunityCandidate),
    ]);
    expect(hashes.size).toBe(3);
  });

  it("keeps a null nested field apart from an absent one", () => {
    const base = candidate({ location: { city: "Przykładowo" } });
    const withNull = { ...base, location: { city: "Przykładowo", county: null } };
    expect(contentHash(withNull as unknown as OpportunityCandidate)).not.toBe(contentHash(base));
  });

  it("does not let a value shift into the next field", () => {
    const a = candidate({ description: null, title: "A" });
    const b = { ...a, description: "A", title: "" };
    expect(contentHash(b)).not.toBe(contentHash(a));
  });

  it("encodes dates as instants: the same instant hashes the same", () => {
    expect(contentHash(candidate({ deadline: new Date(Date.UTC(2026, 10, 12, 9)) }))).toBe(
      contentHash(candidate()),
    );
  });
});

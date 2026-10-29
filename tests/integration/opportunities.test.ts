import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import type { OpportunityDraft } from "../../src/domain/opportunity.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { withDomainErrors } from "../../src/infrastructure/db/errors.js";
import {
  getOpportunity,
  upsertOpportunity,
} from "../../src/infrastructure/db/opportunities-repository.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

let counter = 0;
/** A minimal valid draft: every optional field null, unique fingerprint. */
function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  counter += 1;
  return {
    sourceId: "test-source",
    sourceUrl: `https://zamowienia.example.gov.pl/ogloszenie/${String(counter)}`,
    externalId: null,
    issuerName: "Szkoła Podstawowa nr 1",
    title: "Przegląd instalacji elektrycznej",
    description: null,
    location: null,
    publishedAt: null,
    deadline: null,
    estimatedValue: null,
    currency: null,
    categories: [],
    contact: null,
    fetchedAt: new Date("2026-10-01T08:00:00.000Z"),
    fingerprint: `fp-${String(counter)}`,
    contentHash: "hash-1",
    status: "open",
    ...overrides,
  };
}

async function domainErrorOf(promise: Promise<unknown>): Promise<DomainError> {
  const error: unknown = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe.skipIf(skipWithoutDatabase)("opportunities repository (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    await upsertSource(schema.db, {
      id: "test-source",
      name: "Test source",
      baseUrl: "https://zamowienia.example.gov.pl",
      enabled: true,
    });
    await upsertSource(schema.db, {
      id: "other-source",
      name: "Other source",
      baseUrl: "https://bip.example.gov.pl",
      enabled: true,
    });
  });
  afterAll(async () => {
    await schema.close();
  });

  describe("missing values", () => {
    it("stores an absent estimatedValue as NULL, never 0", async () => {
      const { opportunity } = await upsertOpportunity(schema.db, draft());
      expect(opportunity.estimatedValue).toBeNull();
      expect(opportunity.currency).toBeNull();

      const { rows } = await sql<{ is_null: boolean; is_zero: boolean | null }>`
        SELECT estimated_value IS NULL AS is_null, estimated_value = 0 AS is_zero
        FROM opportunities WHERE id = ${opportunity.id}
      `.execute(schema.db);
      expect(rows).toEqual([{ is_null: true, is_zero: null }]);
    });

    it("stores every absent optional field as NULL", async () => {
      const { opportunity } = await upsertOpportunity(schema.db, draft());
      const { rows } = await sql<Record<string, unknown>>`
        SELECT external_id, description, location, published_at, deadline,
               estimated_value, currency, contact
        FROM opportunities WHERE id = ${opportunity.id}
      `.execute(schema.db);
      expect(Object.values(rows[0] ?? { missing: "row" })).toEqual(Array(8).fill(null));
    });

    it("keeps a published value exactly (decimal string, no float rounding)", async () => {
      const { opportunity } = await upsertOpportunity(
        schema.db,
        draft({ estimatedValue: "12500.10", currency: "PLN" }),
      );
      expect(opportunity.estimatedValue).toBe("12500.10");
      expect(opportunity.currency).toBe("PLN");
      // An explicitly published 0 is a value, distinct from "not published".
      const zero = await upsertOpportunity(
        schema.db,
        draft({ estimatedValue: "0", currency: "PLN" }),
      );
      expect(zero.opportunity.estimatedValue).toBe("0");
    });
  });

  it("round-trips every field", async () => {
    const full = draft({
      externalId: "ZO/12/2026",
      description: "Pomiary ochronne w budynku szkoły.",
      location: { voivodeship: "mazowieckie", county: "warszawski zachodni", city: "Łomianki" },
      publishedAt: new Date("2026-10-01T06:00:00.000Z"),
      deadline: new Date("2026-10-15T10:00:00.000Z"),
      estimatedValue: "48000",
      currency: "PLN",
      categories: ["elektryka", "pomiary"],
      contact: { name: "Jan Kowalski", email: "zamowienia@sp1.example.gov.pl" },
      status: "open",
    });
    const { outcome, opportunity } = await upsertOpportunity(schema.db, full);
    expect(outcome).toBe("inserted");
    expect(opportunity).toMatchObject(full);
    expect(await getOpportunity(schema.db, opportunity.id)).toEqual(opportunity);
  });

  describe("upsert by fingerprint", () => {
    it("inserts, then updates the same row keeping id and first_seen_at", async () => {
      const first = await upsertOpportunity(
        schema.db,
        draft({ fingerprint: "fp-upsert", title: "Old title" }),
      );
      expect(first.outcome).toBe("inserted");

      const second = await upsertOpportunity(
        schema.db,
        draft({
          fingerprint: "fp-upsert",
          title: "New title",
          deadline: new Date("2026-11-01T10:00:00.000Z"),
          fetchedAt: new Date("2026-10-02T08:00:00.000Z"),
          contentHash: "hash-2",
        }),
      );
      expect(second.outcome).toBe("updated");
      expect(second.opportunity.id).toBe(first.opportunity.id);
      expect(second.opportunity.firstSeenAt).toEqual(first.opportunity.firstSeenAt);
      expect(second.opportunity.title).toBe("New title");
      expect(second.opportunity.contentHash).toBe("hash-2");
      expect(second.opportunity.fetchedAt).toEqual(new Date("2026-10-02T08:00:00.000Z"));
      expect(second.opportunity.updatedAt.getTime()).toBeGreaterThanOrEqual(
        first.opportunity.updatedAt.getTime(),
      );

      const { rows } = await sql<{ count: string }>`
        SELECT count(*) AS count FROM opportunities WHERE fingerprint = 'fp-upsert'
      `.execute(schema.db);
      expect(rows[0]?.count).toBe("1");
    });

    it("an update can clear a value back to NULL", async () => {
      await upsertOpportunity(
        schema.db,
        draft({ fingerprint: "fp-clear", estimatedValue: "100", currency: "PLN" }),
      );
      const { opportunity } = await upsertOpportunity(
        schema.db,
        draft({ fingerprint: "fp-clear" }),
      );
      expect(opportunity.estimatedValue).toBeNull();
      expect(opportunity.currency).toBeNull();
    });

    it("refuses to move a fingerprint to another source", async () => {
      await upsertOpportunity(schema.db, draft({ fingerprint: "fp-owned" }));
      const error = await domainErrorOf(
        upsertOpportunity(schema.db, draft({ fingerprint: "fp-owned", sourceId: "other-source" })),
      );
      expect(error.code).toBe("duplicate");
      const stored = await sql<{ source_id: string }>`
        SELECT source_id FROM opportunities WHERE fingerprint = 'fp-owned'
      `.execute(schema.db);
      expect(stored.rows).toEqual([{ source_id: "test-source" }]);
    });
  });

  describe("constraint violations become DomainErrors", () => {
    it("same (source, external id) under another fingerprint → duplicate", async () => {
      await upsertOpportunity(schema.db, draft({ externalId: "EXT-1" }));
      const error = await domainErrorOf(
        upsertOpportunity(schema.db, draft({ externalId: "EXT-1" })),
      );
      expect(error.code).toBe("duplicate");
      expect(error.constraint).toBe("opportunities_source_external_id_key");
      // The message names the rule, never the offending value.
      expect(error.message).not.toContain("EXT-1");
    });

    it("the same external id in another source is allowed", async () => {
      await upsertOpportunity(schema.db, draft({ externalId: "EXT-2" }));
      const other = await upsertOpportunity(
        schema.db,
        draft({ externalId: "EXT-2", sourceId: "other-source" }),
      );
      expect(other.outcome).toBe("inserted");
    });

    it("several notices without external id are allowed (partial unique index)", async () => {
      await upsertOpportunity(schema.db, draft({ externalId: null }));
      const second = await upsertOpportunity(schema.db, draft({ externalId: null }));
      expect(second.outcome).toBe("inserted");
    });

    it("unknown source → unknown_reference", async () => {
      const error = await domainErrorOf(
        upsertOpportunity(schema.db, draft({ sourceId: "no-such-source" })),
      );
      expect(error.code).toBe("unknown_reference");
      expect(error.constraint).toBe("opportunities_source_id_fkey");
    });

    it("value without currency is rejected before reaching the database", async () => {
      const error = await domainErrorOf(
        upsertOpportunity(schema.db, draft({ estimatedValue: "100", currency: null })),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["currency"]);
    });

    it("the database CHECKs hold on their own and map to constraint_violation", async () => {
      const insertRaw = (value: string | null, currency: string | null) =>
        withDomainErrors(() =>
          sql`
            INSERT INTO opportunities (source_id, source_url, issuer_name, title, fetched_at,
                                       fingerprint, content_hash, status,
                                       estimated_value, currency)
            VALUES ('test-source', 'https://zamowienia.example.gov.pl/x', 'Issuer', 'Title',
                    now(), ${`fp-raw-${String((counter += 1))}`}, 'h', 'open',
                    ${value}::numeric, ${currency})
          `.execute(schema.db),
        );

      const missingCurrency = await domainErrorOf(insertRaw("100", null));
      expect(missingCurrency.code).toBe("constraint_violation");
      expect(missingCurrency.constraint).toBe("opportunities_value_currency_check");

      const currencyWithoutValue = await domainErrorOf(insertRaw(null, "PLN"));
      expect(currencyWithoutValue.constraint).toBe("opportunities_value_currency_check");

      const negative = await domainErrorOf(insertRaw("-1", "PLN"));
      expect(negative.code).toBe("constraint_violation");
      expect(negative.constraint).toBe("opportunities_estimated_value_check");
      expect(negative.message).not.toContain("-1");

      // numeric accepts these special values; none of them is an amount.
      for (const special of ["NaN", "Infinity", "-Infinity"]) {
        const error = await domainErrorOf(insertRaw(special, "PLN"));
        expect(error.code).toBe("constraint_violation");
        expect(error.constraint).toBe("opportunities_estimated_value_check");
      }

      for (const currency of ["pl", "pln", "P1N"]) {
        const error = await domainErrorOf(insertRaw("100", currency));
        expect(error.code).toBe("constraint_violation");
        expect(error.constraint).toBe("opportunities_currency_check");
      }
    });

    it("location and contact must be JSON objects in the database too", async () => {
      const insertJson = (column: "location" | "contact", json: string) =>
        withDomainErrors(() =>
          sql`
            INSERT INTO opportunities (source_id, source_url, issuer_name, title, fetched_at,
                                       fingerprint, content_hash, status, ${sql.ref(column)})
            VALUES ('test-source', 'https://zamowienia.example.gov.pl/x', 'Issuer', 'Title',
                    now(), ${`fp-raw-${String((counter += 1))}`}, 'h', 'open', ${json}::jsonb)
          `.execute(schema.db),
        );

      for (const json of ["[1]", '"Warszawa"', "42", "null"]) {
        const location = await domainErrorOf(insertJson("location", json));
        expect(location.code).toBe("constraint_violation");
        expect(location.constraint).toBe("opportunities_location_check");

        const contact = await domainErrorOf(insertJson("contact", json));
        expect(contact.code).toBe("constraint_violation");
        expect(contact.constraint).toBe("opportunities_contact_check");
      }
    });

    it("an invalid status is refused by the database too", async () => {
      const error = await domainErrorOf(
        withDomainErrors(() =>
          sql`
            INSERT INTO opportunities (source_id, source_url, issuer_name, title, fetched_at,
                                       fingerprint, content_hash, status)
            VALUES ('test-source', 'https://zamowienia.example.gov.pl/x', 'Issuer', 'Title',
                    now(), 'fp-bad-status', 'h', 'archived')
          `.execute(schema.db),
        ),
      );
      expect(error.constraint).toBe("opportunities_status_check");
    });

    it("a NOT NULL violation maps to constraint_violation naming the column", async () => {
      const error = await domainErrorOf(
        withDomainErrors(() =>
          sql`
            INSERT INTO opportunities (source_id, source_url, issuer_name, fetched_at,
                                       fingerprint, content_hash, status)
            VALUES ('test-source', 'https://zamowienia.example.gov.pl/x', 'Issuer',
                    now(), 'fp-no-title', 'h', 'open')
          `.execute(schema.db),
        ),
      );
      expect(error.code).toBe("constraint_violation");
      expect(error.fields).toEqual(["title"]);
    });
  });

  describe("stored values", () => {
    it("stores the canonical source URL and refuses whitespace in it", async () => {
      const { opportunity } = await upsertOpportunity(
        schema.db,
        draft({ sourceUrl: "HTTPS://Zamowienia.Example.gov.pl/ogloszenie/<1>" }),
      );
      const { rows } = await sql<{ source_url: string }>`
        SELECT source_url FROM opportunities WHERE id = ${opportunity.id}
      `.execute(schema.db);
      expect(rows).toEqual([
        { source_url: "https://zamowienia.example.gov.pl/ogloszenie/%3C1%3E" },
      ]);

      const error = await domainErrorOf(
        upsertOpportunity(
          schema.db,
          draft({ sourceUrl: "https://zamowienia.example.gov.pl/a b\n<script>" }),
        ),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.fields).toEqual(["sourceUrl"]);
    });

    it("refuses lone surrogates instead of letting PostgreSQL replace them", async () => {
      const error = await domainErrorOf(
        upsertOpportunity(
          schema.db,
          draft({ title: "Remont\ud800", categories: ["x\udc00"], location: { city: "\ud800" } }),
        ),
      );
      expect(error.code).toBe("invalid_input");
      expect([...error.fields].sort()).toEqual(["categories.0", "location.city", "title"]);
    });

    it("a stored row that no longer matches the schema → invalid_stored_row", async () => {
      const { opportunity } = await upsertOpportunity(
        schema.db,
        draft({ location: { city: "Łódź" } }),
      );
      // Simulate a manual edit that bypassed the application.
      await sql`
        UPDATE opportunities SET location = '{"foo": 1}' WHERE id = ${opportunity.id}
      `.execute(schema.db);

      const error = await domainErrorOf(getOpportunity(schema.db, opportunity.id));
      expect(error.code).toBe("invalid_stored_row");
      expect(error.rowId).toBe(opportunity.id);
      expect(error.fields).toEqual(["location"]);
      // Names the row and field only — never the stored value or its keys.
      expect(error.message).toContain(opportunity.id);
      expect(error.message).not.toContain("foo");
    });
  });

  describe("getOpportunity", () => {
    it("returns null for an unknown id", async () => {
      expect(await getOpportunity(schema.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("rejects a malformed id as invalid_input", async () => {
      const error = await domainErrorOf(getOpportunity(schema.db, "1; DROP TABLE opportunities"));
      expect(error.code).toBe("invalid_input");
    });
  });
});

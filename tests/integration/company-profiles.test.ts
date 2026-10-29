import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompanyProfileInput } from "../../src/domain/company-profile.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  createCompanyProfile,
  deleteCompanyProfile,
  getCompanyProfile,
  updateCompanyProfile,
} from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { withDomainErrors } from "../../src/infrastructure/db/errors.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

function profile(overrides: Partial<CompanyProfileInput> = {}): CompanyProfileInput {
  return {
    email: "biuro@elektro.example.pl",
    name: "Elektro Sp. z o.o.",
    categories: ["elektryka"],
    includeKeywords: ["instalacja elektryczna", "pomiary"],
    excludeKeywords: ["dostawa paliwa"],
    voivodeships: ["mazowieckie"],
    counties: [],
    active: true,
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

describe.skipIf(skipWithoutDatabase)("company profiles repository (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });

  it("create → get → update → delete", async () => {
    const created = await createCompanyProfile(
      schema.db,
      profile({ email: "  Crud@Example.PL ", counties: ["warszawski zachodni"] }),
    );
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({
      email: "crud@example.pl", // trimmed and lower-cased
      name: "Elektro Sp. z o.o.",
      counties: ["warszawski zachodni"],
      active: true,
    });
    expect(await getCompanyProfile(schema.db, created.id)).toEqual(created);

    const updated = await updateCompanyProfile(schema.db, created.id, {
      active: false,
      excludeKeywords: [],
    });
    expect(updated).toMatchObject({
      id: created.id,
      email: "crud@example.pl",
      active: false,
      excludeKeywords: [],
      includeKeywords: ["instalacja elektryczna", "pomiary"], // untouched
    });
    expect(updated?.createdAt).toEqual(created.createdAt);

    expect(await deleteCompanyProfile(schema.db, created.id)).toBe(true);
    expect(await getCompanyProfile(schema.db, created.id)).toBeNull();
    expect(await deleteCompanyProfile(schema.db, created.id)).toBe(false);
  });

  it("returns null when updating a profile that does not exist", async () => {
    expect(
      await updateCompanyProfile(schema.db, "00000000-0000-4000-8000-000000000000", {
        active: false,
      }),
    ).toBeNull();
  });

  it("refuses a duplicate e-mail, case-insensitively, without echoing it", async () => {
    await createCompanyProfile(schema.db, profile({ email: "dup@example.pl" }));
    const error = await domainErrorOf(
      createCompanyProfile(schema.db, profile({ email: "DUP@example.pl" })),
    );
    expect(error.code).toBe("duplicate");
    expect(error.constraint).toBe("company_profiles_email_key");
    expect(error.message).not.toContain("dup@example.pl");
  });

  it("refuses changing the e-mail to one already in use", async () => {
    await createCompanyProfile(schema.db, profile({ email: "taken@example.pl" }));
    const other = await createCompanyProfile(schema.db, profile({ email: "free@example.pl" }));
    const error = await domainErrorOf(
      updateCompanyProfile(schema.db, other.id, { email: "taken@example.pl" }),
    );
    expect(error.code).toBe("duplicate");
  });

  it("rejects invalid input naming the fields only", async () => {
    const error = await domainErrorOf(
      createCompanyProfile(schema.db, profile({ email: "not-an-email", name: "   " })),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.fields).toEqual(["email", "name"]);
    expect(error.message).not.toContain("not-an-email");
  });

  it("the database refuses a non-normalized e-mail on its own", async () => {
    for (const email of [" a@b.pl", "a@b.pl ", "A@b.pl"]) {
      const error = await domainErrorOf(
        withDomainErrors(() =>
          sql`INSERT INTO company_profiles (email, name) VALUES (${email}, 'Raw')`.execute(
            schema.db,
          ),
        ),
      );
      expect(error.code).toBe("constraint_violation");
      expect(error.constraint).toBe("company_profiles_email_check");
    }
  });

  it("rejects an empty update", async () => {
    const created = await createCompanyProfile(
      schema.db,
      profile({ email: "empty-patch@example.pl" }),
    );
    const error = await domainErrorOf(updateCompanyProfile(schema.db, created.id, {}));
    expect(error.code).toBe("invalid_input");
  });
});

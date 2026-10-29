import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import {
  getSource,
  listEnabledSources,
  upsertSource,
} from "../../src/infrastructure/db/sources-repository.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

describe.skipIf(skipWithoutDatabase)("sources repository (PostgreSQL)", () => {
  let schema: TestSchema;
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
  });
  afterAll(async () => {
    await schema.close();
  });

  it("registers a source and reads it back", async () => {
    const created = await upsertSource(schema.db, {
      id: "bip-example",
      name: "BIP Example",
      baseUrl: "https://bip.example.gov.pl",
      enabled: true,
    });
    expect(created).toMatchObject({
      id: "bip-example",
      name: "BIP Example",
      baseUrl: "https://bip.example.gov.pl",
      enabled: true,
    });
    expect(await getSource(schema.db, "bip-example")).toEqual(created);
  });

  it("upsert updates an existing source in place", async () => {
    const before = await upsertSource(schema.db, {
      id: "bip-update",
      name: "Old name",
      baseUrl: "https://bip.example.gov.pl",
      enabled: true,
    });
    const after = await upsertSource(schema.db, {
      id: "bip-update",
      name: "New name",
      baseUrl: "https://bip2.example.gov.pl",
      enabled: false,
    });
    expect(after).toMatchObject({
      name: "New name",
      baseUrl: "https://bip2.example.gov.pl",
      enabled: false,
    });
    expect(after.createdAt).toEqual(before.createdAt);
  });

  it("returns null for an unknown source", async () => {
    expect(await getSource(schema.db, "no-such-source")).toBeNull();
  });

  it("lists only enabled sources, ordered and bounded by the limit", async () => {
    for (const id of ["list-c", "list-a", "list-b"]) {
      await upsertSource(schema.db, {
        id,
        name: id,
        baseUrl: "https://bip.example.gov.pl",
        enabled: true,
      });
    }
    await upsertSource(schema.db, {
      id: "list-disabled",
      name: "disabled",
      baseUrl: "https://bip.example.gov.pl",
      enabled: false,
    });

    const ids = (await listEnabledSources(schema.db)).map((source) => source.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(["list-a", "list-b", "list-c"]));
    expect(ids).not.toContain("list-disabled");
    expect(ids).not.toContain("bip-update"); // disabled by the previous test

    expect(await listEnabledSources(schema.db, 2)).toHaveLength(2);
  });

  it("rejects an out-of-range limit", async () => {
    await expect(listEnabledSources(schema.db, 0)).rejects.toBeInstanceOf(DomainError);
    await expect(listEnabledSources(schema.db, 1001)).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects invalid input before touching the database", async () => {
    await expect(
      upsertSource(schema.db, {
        id: "Not A Valid Id",
        name: "x",
        baseUrl: "javascript:alert(1)",
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fields: ["id", "baseUrl"] });
  });
});

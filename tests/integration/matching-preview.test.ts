import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCliDeps, defaultSourceDeps, ExitCode, runCli } from "../../src/cli.js";
import type { CompanyProfileInput } from "../../src/domain/company-profile.js";
import { DomainError } from "../../src/domain/errors.js";
import type { OpportunityDraft } from "../../src/domain/opportunity.js";
import {
  createCompanyProfile,
  getCompanyProfile,
  updateCompanyProfile,
} from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import {
  listMatchCandidates,
  upsertOpportunity,
} from "../../src/infrastructure/db/opportunities-repository.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

// PR-04 with PostgreSQL: the candidate query of match:preview and the profile
// commands end to end. Pseudonymised data only.

/** The preview's clock, so whether a deadline has passed does not depend on the test date. */
const NOW = new Date("2026-10-31T08:00:00.000Z");

let counter = 0;
function draft(overrides: Partial<OpportunityDraft> = {}): OpportunityDraft {
  counter += 1;
  return {
    sourceId: "test-source",
    sourceUrl: `https://zamowienia.example.gov.pl/ogloszenie/${String(counter)}`,
    externalId: null,
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: "Modernizacja oświetlenia ulicznego",
    description: null,
    location: { voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-10-20T08:00:00.000Z"),
    deadline: new Date("2026-11-20T11:00:00.000Z"),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: { name: "Jan Kowalski", email: "kontakt@example.invalid", phone: "000 000 000" },
    fetchedAt: new Date("2026-10-20T09:00:00.000Z"),
    fingerprint: `fp-${String(counter)}`,
    contentHash: "hash-1",
    status: "open",
    ...overrides,
  };
}

const profileInput = {
  email: "kontakt@example.invalid",
  name: "Jan Kowalski Elektryka",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie"],
  excludeKeywords: ["paliwo"],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
} satisfies CompanyProfileInput;

async function run(args: string[], databaseUrl: string) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { NODE_ENV: "test", DATABASE_URL: databaseUrl },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    { ...defaultCliDeps, sources: { ...defaultSourceDeps, now: () => NOW } },
  );
  return { code, stdout, stderr };
}

describe.skipIf(skipWithoutDatabase)("matching preview (PostgreSQL)", () => {
  let schema: TestSchema;
  let dir = "";
  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    await upsertSource(schema.db, {
      id: "test-source",
      name: "Test source",
      baseUrl: "https://zamowienia.example.gov.pl",
      enabled: true,
    });
    dir = await mkdtemp(join(tmpdir(), "radar-matching-it-"));
  });
  afterAll(async () => {
    await schema.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function store(overrides: Partial<OpportunityDraft>) {
    return (await upsertOpportunity(schema.db, draft(overrides))).opportunity;
  }

  it("lists candidates newest first, without closed and cancelled offers, bounded", async () => {
    await sql`DELETE FROM opportunities`.execute(schema.db);
    const old = await store({ title: "old", publishedAt: new Date("2026-10-01T08:00:00.000Z") });
    const newest = await store({ title: "new", publishedAt: new Date("2026-10-25T08:00:00.000Z") });
    const tieA = await store({ title: "tie a", publishedAt: new Date("2026-10-10T08:00:00.000Z") });
    const tieB = await store({ title: "tie b", publishedAt: new Date("2026-10-10T08:00:00.000Z") });
    const unpublished = await store({ title: "no date", publishedAt: null, status: "unknown" });
    await store({ title: "closed", status: "closed" });
    await store({ title: "cancelled", status: "cancelled" });

    const ties = [tieA, tieB].sort((a, b) => (a.id < b.id ? -1 : 1)).map((o) => o.id);
    const all = await listMatchCandidates(schema.db);
    expect(all.skipped).toEqual([]);
    expect(all.offers.map((o) => o.id)).toEqual([newest.id, ...ties, old.id, unpublished.id]);
    expect(all.offers.map((o) => o.status)).not.toContain("closed");
    expect(all.offers.map((o) => o.status)).not.toContain("cancelled");
    expect((await listMatchCandidates(schema.db, 2)).offers.map((o) => o.id)).toEqual([
      newest.id,
      ties[0],
    ]);
    await expect(listMatchCandidates(schema.db, 1001)).rejects.toThrow();
  });

  it("creates, shows and previews a profile through the CLI", async () => {
    await sql`DELETE FROM opportunities`.execute(schema.db);
    // Newest, so --limit 1 below reads this (matching) offer; the others share
    // a publication time and are ordered by random id.
    await store({
      title: "Oświetlenie boiska",
      deadline: new Date("2026-11-10T11:00:00.000Z"),
      publishedAt: new Date("2026-10-21T08:00:00.000Z"),
    });
    await store({ title: "Modernizacja oświetlenia", deadline: null });
    await store({ title: "Oświetlenie i dostawa paliwa" });
    await store({ title: "Oświetlenie hali", status: "closed" });
    await store({ title: "Remont dachu", categories: ["45453000-7"] });

    const file = join(dir, "profile.json");
    await writeFile(
      file,
      JSON.stringify({ ...profileInput, voivodeships: ["Mazowieckie"], active: false }),
    );
    const created = await run(["profile:create", file], schema.url);
    expect(created.code).toBe(ExitCode.Ok);
    const { id } = JSON.parse(created.stdout) as { id: string };

    const shown = await run(["profile:show", id], schema.url);
    expect(shown.code).toBe(ExitCode.Ok);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      id,
      ...profileInput,
      voivodeships: ["mazowieckie"],
      active: false,
    });

    const duplicate = await run(["profile:create", file], schema.url);
    expect(duplicate.code).toBe(ExitCode.Failure);
    expect(duplicate.stderr).toBe(
      "Profile not created: a profile with this e-mail already exists\n",
    );

    const preview = await run(["match:preview", id], schema.url);
    expect(preview.code).toBe(ExitCode.Ok);
    expect(preview.stderr).toBe("");
    const lines = preview.stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("["))).toEqual([
      "[90] Oświetlenie boiska",
      "[90] Modernizacja oświetlenia",
    ]);
    expect(preview.stdout).toContain("Uwaga: profil jest nieaktywny");
    expect(preview.stdout).toContain("  termin: 2026-11-10 12:00");
    expect(preview.stdout).toContain("  termin: brak terminu");
    expect(preview.stdout.endsWith("\ndopasowane 2 z 4\n")).toBe(true);
    for (const contact of ["kontakt@example.invalid", "000 000 000"]) {
      expect(preview.stdout).not.toContain(contact);
    }

    const limited = await run(["match:preview", id, "--limit", "1"], schema.url);
    expect(limited.stdout.endsWith("\ndopasowane 1 z 1\n")).toBe(true);

    const unknown = await run(
      ["match:preview", "00000000-0000-4000-8000-000000000000"],
      schema.url,
    );
    expect(unknown.code).toBe(ExitCode.Failure);
    expect(unknown.stderr).toBe("Profile not found.\n");
  });

  it("skips invalid stored offers with a warning, but fails on an invalid profile", async () => {
    await sql`DELETE FROM opportunities`.execute(schema.db);
    const good = await store({ title: "Oświetlenie boiska" });
    const badLocation = await store({ title: "Oświetlenie szkoły" });
    const badContact = await store({ title: "Oświetlenie hali" });
    await sql`UPDATE opportunities SET location = '{"voivodeship": 5}'::jsonb
              WHERE id = ${badLocation.id}`.execute(schema.db);
    await sql`UPDATE opportunities SET contact = '{"email": "tajny-sekret"}'::jsonb
              WHERE id = ${badContact.id}`.execute(schema.db);

    const listed = await listMatchCandidates(schema.db);
    expect(listed.offers.map((o) => o.id)).toEqual([good.id]);
    expect([...listed.skipped].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [
        { id: badLocation.id, fields: ["location.voivodeship"] },
        { id: badContact.id, fields: ["contact.email"] },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );

    const created = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "jan.kowalski.skip@example.invalid",
    });
    const preview = await run(["match:preview", created.id], schema.url);
    expect(preview.code).toBe(ExitCode.Ok);
    expect(preview.stdout.split("\n").filter((line) => line.startsWith("["))).toEqual([
      "[90] Oświetlenie boiska",
    ]);
    expect(preview.stdout.endsWith("\ndopasowane 1 z 1, pominięto 2 nieprawidłowe wiersze\n")).toBe(
      true,
    );
    const warnings = preview.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(warnings.map((warning) => warning.rowId).sort()).toEqual(
      [badLocation.id, badContact.id].sort(),
    );
    for (const warning of warnings) {
      expect(warning).toMatchObject({
        level: "warn",
        message: "match:preview skipped an invalid stored offer",
      });
    }
    expect(preview.stderr).not.toContain("tajny-sekret");
    expect(preview.stdout).not.toContain("tajny-sekret");

    await sql`UPDATE company_profiles SET categories = '{}' WHERE id = ${created.id}`.execute(
      schema.db,
    );
    const broken = await run(["match:preview", created.id], schema.url);
    expect(broken.code).toBe(ExitCode.Failure);
    expect(broken.stderr).toContain("(invalid_stored_row)");
    expect(broken.stdout).toBe("");
  });

  it("refuses a stored profile that no longer satisfies the schema", async () => {
    const created = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "jan.kowalski@example.invalid",
    });
    await sql`UPDATE company_profiles SET categories = '{}', voivodeships = '{Mazowsze}'
              WHERE id = ${created.id}`.execute(schema.db);
    const error: unknown = await getCompanyProfile(schema.db, created.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "invalid_stored_row",
      fields: ["categories", "voivodeships.0"],
      rowId: created.id,
    });
    expect((error as DomainError).message).not.toContain("Mazowsze");

    const shown = await run(["profile:show", created.id], schema.url);
    expect(shown.code).toBe(ExitCode.Failure);
    expect(shown.stderr).toContain("(invalid_stored_row)");
    expect(shown.stderr).not.toContain("Mazowsze");
  });

  it("rolls back an update whose result does not satisfy the schema", async () => {
    const created = await createCompanyProfile(schema.db, {
      ...profileInput,
      email: "jan.kowalski.update@example.invalid",
    });
    await sql`UPDATE company_profiles SET categories = '{}' WHERE id = ${created.id}`.execute(
      schema.db,
    );
    const before = await sql<{ active: boolean; updated_at: Date }>`
      SELECT active, updated_at FROM company_profiles WHERE id = ${created.id}`.execute(schema.db);

    const error: unknown = await updateCompanyProfile(schema.db, created.id, {
      active: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "invalid_stored_row", fields: ["categories"] });

    const after = await sql<{ active: boolean; updated_at: Date }>`
      SELECT active, updated_at FROM company_profiles WHERE id = ${created.id}`.execute(schema.db);
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]?.active).toBe(true);
  });
});

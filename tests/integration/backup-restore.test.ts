import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultCliDeps, defaultDigestDeps, ExitCode, runCli } from "../../src/cli.js";
import {
  consumeLoginToken,
  issueAccessToken,
} from "../../src/infrastructure/db/access-repository.js";
import { createCompanyProfile } from "../../src/infrastructure/db/company-profiles-repository.js";
import { migrateToLatest } from "../../src/infrastructure/db/database.js";
import { recordIngestionRun } from "../../src/infrastructure/db/ingestion-runs-repository.js";
import { upsertOpportunity } from "../../src/infrastructure/db/opportunities-repository.js";
import { upsertSource } from "../../src/infrastructure/db/sources-repository.js";
import { createTestSchema, skipWithoutDatabase, type TestSchema } from "./test-database.js";

/*
 * PR-07A with PostgreSQL: `backup` then `restore` end to end with the real
 * pg_dump/pg_restore. It drops its schema's tables, so it runs alone after
 * every other file (vitest.config.ts). Pseudonymised data only.
 */

/** A flag counts as set unless it is absent, empty, "0" or "false" (as in global-setup.ts). */
function flagSet(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false"].includes(value.toLowerCase());
}

/** The major version of a PostgreSQL client tool on PATH; null when it is missing. */
function toolMajor(tool: string): number | null {
  try {
    const output = execFileSync(tool, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const match = /\(PostgreSQL\) (\d+)/.exec(output);
    return match?.[1] === undefined ? null : Number(match[1]);
  } catch {
    return null;
  }
}

const MIN_TOOL_MAJOR = 16;
const majors = { pg_dump: toolMajor("pg_dump"), pg_restore: toolMajor("pg_restore") };
const toolsUsable = Object.values(majors).every(
  (major) => major !== null && major >= MIN_TOOL_MAJOR,
);
/** In CI (or with REQUIRE_DB_TESTS) missing tools fail the run instead of skipping it. */
const toolsRequired = flagSet(process.env.CI) || flagSet(process.env.REQUIRE_DB_TESTS);

describe.skipIf(skipWithoutDatabase)("backup tools", () => {
  // Skipped (with a notice) only where the tools are not required.
  it.skipIf(!toolsUsable && !toolsRequired)(
    `pg_dump and pg_restore >= ${String(MIN_TOOL_MAJOR)} are on PATH`,
    () => {
      expect({ majors, toolsUsable }).toEqual({
        majors: {
          pg_dump: expect.any(Number) as number,
          pg_restore: expect.any(Number) as number,
        },
        toolsUsable: true,
      });
    },
  );
});

if (!skipWithoutDatabase && !toolsUsable && !toolsRequired) {
  process.stderr.write(
    `\nNOTICE: pg_dump/pg_restore >= ${String(MIN_TOOL_MAJOR)} not found — the backup/restore ` +
      "integration test is SKIPPED.\n\n",
  );
}

const NOW = new Date("2026-11-02T07:00:00.000Z");
const EMAIL = "kontakt@example.invalid";

describe.skipIf(skipWithoutDatabase || !toolsUsable)("backup and restore (PostgreSQL)", () => {
  let schema: TestSchema;
  let dir = "";
  let schemaName = "";
  let before: Record<string, unknown[]> = {};

  const env = () => ({
    DATABASE_URL: schema.url,
    LOG_LEVEL: "error",
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
  });

  async function cli(args: string[], extraEnv: Record<string, string> = {}) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      args,
      {
        env: { ...env(), ...extraEnv },
        stdout: (text) => (stdout += text),
        stderr: (text) => (stderr += text),
      },
      { ...defaultCliDeps, digest: { ...defaultDigestDeps, now: () => NOW } },
    );
    // The connection URL (with its password) is never printed.
    expect(stdout + stderr).not.toContain(schema.url);
    expect(stdout + stderr).not.toMatch(/:\/\/[^\s]*@/);
    return { code, stdout, stderr };
  }

  /** Every row of every application table, in a fixed order (what must survive). */
  async function snapshot(): Promise<Record<string, unknown[]>> {
    const tables = [
      "sources",
      "opportunities",
      "company_profiles",
      "ingestion_runs",
      "deliveries",
      "access_tokens",
      "sessions",
    ] as const;
    const result: Record<string, unknown[]> = {};
    for (const table of tables) {
      const { rows } = await sql<Record<string, unknown>>`
        SELECT * FROM ${sql.table(table)} ORDER BY id
      `.execute(schema.db);
      result[table] = rows;
    }
    return result;
  }

  beforeAll(async () => {
    schema = await createTestSchema();
    await migrateToLatest(schema.db);
    const { rows } = await sql<{ name: string }>`SELECT current_schema() AS name`.execute(
      schema.db,
    );
    schemaName = rows[0]?.name ?? "";
    dir = await mkdtemp(join(tmpdir(), "radar-backup-it-"));

    await upsertSource(schema.db, {
      id: "test-source",
      name: "Źródło testowe",
      baseUrl: "https://zamowienia.example.gov.pl",
      enabled: true,
    });
    await recordIngestionRun(schema.db, {
      sourceId: "test-source",
      publicationDate: "2026-11-01",
      maxRecords: 1000,
      status: "incomplete",
      startedAt: new Date("2026-11-02T05:00:00.000Z"),
      finishedAt: new Date("2026-11-02T05:01:00.000Z"),
      counters: {
        documents: 2,
        extracted: 2,
        inserted: 2,
        updated: 0,
        unchanged: 0,
        rejected: 0,
        skipped: 0,
      },
      incomplete: [{ part: "contract_notice", reason: "max_records" }],
      errorCode: null,
    });
    const profile = await createCompanyProfile(schema.db, {
      email: EMAIL,
      name: "Anna Nowak Instalacje",
      categories: ["elektryka"],
      includeKeywords: ["oświetlenie", "rozdzielnica"],
      excludeKeywords: ["paliwo"],
      voivodeships: ["mazowieckie"],
      counties: ["warszawski zachodni"],
      active: true,
    });
    const opportunity = await upsertOpportunity(schema.db, {
      sourceId: "test-source",
      sourceUrl: "https://zamowienia.example.gov.pl/ogloszenie/1",
      externalId: "2026/BZP 00000001/01",
      tenderId: null,
      issuerName: "Gmina Przykładowa",
      title: "Modernizacja oświetlenia ulicznego — „etap II”",
      description: "Wymiana opraw.\nDruga linia.",
      location: { voivodeship: "mazowieckie", county: "warszawski zachodni" },
      publishedAt: new Date("2026-10-30T08:00:00.000Z"),
      deadline: new Date("2026-11-20T11:00:00.000Z"),
      estimatedValue: "123456.78",
      currency: "PLN",
      categories: ["45310000-3"],
      contact: { name: "Jan Kowalski", email: EMAIL },
      fetchedAt: new Date("2026-11-02T05:00:30.000Z"),
      fingerprint: "backup-fp-1",
      contentHash: "hash-1",
      status: "open",
    });
    await schema.db
      .insertInto("deliveries")
      .values({
        profile_id: profile.id,
        opportunity_id: opportunity.opportunity.id,
        transport: "test",
        digest_date: "2026-11-02",
        status: "failed",
        attempts: 1,
        error_code: "smtp_transient",
        sent_at: null,
      })
      .execute();
    await issueAccessToken(schema.db, profile.id, "unsubscribe");
    const login = await issueAccessToken(schema.db, profile.id, "login");
    expect(await consumeLoginToken(schema.db, login.token)).not.toBeNull();

    before = await snapshot();
    for (const rowsOfTable of Object.values(before)) expect(rowsOfTable.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await schema.close();
    await rm(dir, { recursive: true, force: true });
  });

  let file = "";

  it("backs up the schema into a new owner-only file", async () => {
    const result = await cli(["backup", dir]);
    expect(result.code).toBe(ExitCode.Ok);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output).toMatchObject({
      status: "ok",
      file: join(dir, "radar-20261102T070000Z.dump"),
      schema: schemaName,
      tables: 9,
    });
    file = String(output.file);
    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);
    expect(output.bytes).toBe(info.size);
    expect(await readdir(dir)).toEqual(["radar-20261102T070000Z.dump"]);
  });

  it("never replaces an existing backup", async () => {
    const result = await cli(["backup", dir]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("(file_exists)");
    expect(await readdir(dir)).toEqual(["radar-20261102T070000Z.dump"]);
  });

  it("leaves nothing behind when pg_dump cannot be found", async () => {
    const empty = join(dir, "empty");
    await mkdir(empty);
    const result = await cli(["backup", empty], { PATH: "" });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toContain("(tool_not_found)");
    expect(await readdir(empty)).toEqual([]);
    await rm(empty, { recursive: true });
  });

  it("refuses a PG* connection variable, naming the variable only", async () => {
    const value = "elsewhere.example.invalid";
    const backup = await cli(["backup", dir], { PGHOST: value });
    expect(backup.code).toBe(ExitCode.Failure);
    expect(backup.stderr).toContain("(unsupported_database_url, PGHOST)");
    expect(backup.stderr).not.toContain(value);
    const restore = await cli(["restore", file], { PGSSLMODE: "require" });
    expect(restore.code).toBe(ExitCode.Failure);
    expect(restore.stderr).toContain("(unsupported_database_url, PGSSLMODE)");
    expect(restore.stderr).not.toContain("require");
    expect(await readdir(dir)).toEqual(["radar-20261102T070000Z.dump"]);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses to restore over a schema that holds data", async () => {
    const result = await cli(["restore", file]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Restore failed: the target schema is not empty; restore only into an empty schema (target_not_empty).\n",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("restores everything into the emptied schema", async () => {
    await sql`DROP SCHEMA ${sql.id(schemaName)} CASCADE`.execute(schema.db);
    await sql`CREATE SCHEMA ${sql.id(schemaName)}`.execute(schema.db);

    // Not a dump: refused, and nothing is left half-restored (one transaction).
    const garbage = join(dir, "not-a-dump.dump");
    await writeFile(garbage, "not a dump\n", { mode: 0o600 });
    const refused = await cli(["restore", garbage]);
    expect(refused.code).toBe(ExitCode.Failure);
    expect(refused.stderr).toContain("(tool_failed, exit 1)");
    const { rows } = await sql<{ count: string }>`
      SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schemaName}
    `.execute(schema.db);
    expect(rows[0]?.count).toBe("0");

    const result = await cli(["restore", file]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      schema: schemaName,
      pendingMigrations: [],
      tables: {
        sources: before.sources?.length,
        opportunities: 1,
        company_profiles: 1,
        ingestion_runs: 1,
        deliveries: 1,
        access_tokens: 2,
        sessions: 1,
      },
    });
    // Every row and column as it was: arrays, jsonb, timestamps, numerics.
    expect(await snapshot()).toEqual(before);

    const health = await cli(["health"]);
    expect(health.code).toBe(ExitCode.Ok);
    // The restored schema works: a new row gets a fresh id from its default.
    await upsertSource(schema.db, {
      id: "after-restore",
      name: "Po odtworzeniu",
      baseUrl: "https://zamowienia.example.gov.pl",
      enabled: false,
    });
  });
});

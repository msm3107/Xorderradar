import { join } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

// Matching must stay pure (D-023): the project ESLint config allows
// src/matching to import only its own modules, the domain and the pure
// normalization helpers. These tests lint snippets with that config so the
// guard cannot silently disappear. Type-aware rules are switched off: the
// snippets are not files of the project.

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfig: [tseslint.configs.disableTypeChecked],
});

async function restrictedImports(code: string, file: string): Promise<number> {
  const [result] = await eslint.lintText(`${code}\n`, { filePath: join(process.cwd(), file) });
  if (result === undefined) throw new Error("ESLint returned no result");
  expect(result.messages.filter((message) => message.fatal === true)).toEqual([]);
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports").length;
}

describe("dependency guard for src/matching", () => {
  it.each([
    'export { tokenize } from "./text.js";',
    'export type { Opportunity } from "../domain/opportunity.js";',
    'import type { CompanyProfile } from "../domain/company-profile.js";\nexport type P = CompanyProfile;',
    'export { comparableText } from "../sources/normalize/comparable.js";',
    'export * from "../sources/normalize/regions.js";',
  ])("allows %s", async (code) => {
    expect(await restrictedImports(code, "src/matching/probe.ts")).toBe(0);
  });

  it.each([
    'import { sql } from "kysely";\nexport { sql };',
    'import pg from "pg";\nexport { pg };',
    'import { readFile } from "node:fs/promises";\nexport { readFile };',
    'export * from "../infrastructure/db/opportunities-repository.js";',
    'export { loadConfig } from "../config.js";',
    'export * from "../sources/bzp/adapter.js";',
    'export * from "../sources/normalize/../bzp/adapter.js";',
    'import type { Kysely } from "kysely";\nexport type K = Kysely<object>;',
    'export * from "./nested/../../infrastructure/logger.js";',
  ])("rejects %s", async (code) => {
    expect(await restrictedImports(code, "src/matching/probe.ts")).toBe(1);
  });

  it("does not restrict other modules", async () => {
    expect(
      await restrictedImports(
        'import { sql } from "kysely";\nexport { sql };\nexport * from "../matching/match.js";',
        "src/infrastructure/probe.ts",
      ),
    ).toBe(0);
  });
});

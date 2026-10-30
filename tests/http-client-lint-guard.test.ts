import { join } from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";

// SafeHttpClientDeps can bypass address pinning and rate limiting, so the
// project ESLint config forbids passing them anywhere under src/. These tests
// lint snippets with that config so the guard cannot silently disappear.
// Type-aware rules are switched off: the snippets are not files of the project.

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfig: [tseslint.configs.disableTypeChecked],
});

const HEADER = [
  'import { SafeHttpClient } from "./infrastructure/http/safe-http-client.js";',
  'import * as http from "./infrastructure/http/safe-http-client.js";',
  "declare const options: ConstructorParameters<typeof SafeHttpClient>[0];",
  "declare const args: [typeof options];",
].join("\n");

async function restrictedSyntax(body: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(`${HEADER}\n${body}\n`, {
    filePath: join(process.cwd(), file),
  });
  if (result === undefined) throw new Error("ESLint returned no result");
  const fatal = result.messages.filter((message) => message.fatal === true);
  expect(fatal).toEqual([]);
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.message);
}

describe("lint guard for SafeHttpClient test seams", () => {
  it("allows constructing the client with options only in src/", async () => {
    expect(
      await restrictedSyntax(
        [
          "export const client = new SafeHttpClient(options);",
          "export const viaNamespace = new http.SafeHttpClient(options);",
        ].join("\n"),
        "src/probe.ts",
      ),
    ).toEqual([]);
  });

  it.each([
    ["a deps argument", "export const client = new SafeHttpClient(options, {});"],
    ["spread arguments", "export const client = new SafeHttpClient(...args);"],
    ["a subclass", "export class Unsafe extends SafeHttpClient {}"],
    [
      "deps through a namespace import",
      "export const client = new http.SafeHttpClient(options, {});",
    ],
    [
      "spread through a namespace import",
      "export const client = new http.SafeHttpClient(...args);",
    ],
    ["a subclass of the namespace member", "export class Unsafe extends http.SafeHttpClient {}"],
    [
      "a renamed import",
      'import { SafeHttpClient as Client } from "./infrastructure/http/safe-http-client.js";\nexport { Client };',
    ],
  ])("rejects %s in src/", async (_label, body) => {
    const messages = await restrictedSyntax(body, "src/sources/probe.ts");
    expect(messages).toHaveLength(1);
  });

  it("allows a renamed import in tests/", async () => {
    expect(
      await restrictedSyntax(
        'import { SafeHttpClient as Client } from "../src/infrastructure/http/safe-http-client.js";\nexport { Client };',
        "tests/probe.test.ts",
      ),
    ).toEqual([]);
  });

  it("allows deps in tests/", async () => {
    expect(
      await restrictedSyntax(
        "export const client = new SafeHttpClient(options, {});",
        "tests/probe.test.ts",
      ),
    ).toEqual([]);
  });
});

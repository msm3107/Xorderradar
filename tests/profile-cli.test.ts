import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultSourceDeps,
  ExitCode,
  INTERNAL_ERROR_MESSAGE,
  runCli,
  type CliDatabase,
} from "../src/cli.js";
import {
  companyProfileInputSchema,
  type CompanyProfile,
  type CompanyProfileInput,
} from "../src/domain/company-profile.js";
import { DomainError } from "../src/domain/errors.js";
import type { Opportunity } from "../src/domain/opportunity.js";
import type {
  MatchCandidates,
  SkippedRow,
} from "../src/infrastructure/db/opportunities-repository.js";
import { MVP_CATEGORIES } from "../src/domain/vocabulary.js";
import { formatWarsawMinute, PROFILE_FILE_MAX_BYTES } from "../src/profile-commands.js";

// Unit tests of profile:create, profile:show and match:preview with a stub
// database. Pseudonymised data only (kontakt@example.invalid, Jan Kowalski).

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const PROFILE_ID = "6f1c2a52-6d3e-4c55-9a4b-2f7c3f1d9e01";
/** The preview's clock: before every deadline of storedOffer unless a test says otherwise. */
const NOW = new Date("2026-10-25T08:00:00.000Z");

function found(offers: Opportunity[], skipped: SkippedRow[] = []): Promise<MatchCandidates> {
  return Promise.resolve({ offers, skipped });
}

const validInput = {
  email: "kontakt@example.invalid",
  name: "Jan Kowalski Elektryka",
  categories: ["elektryka"],
  includeKeywords: ["oświetlenie"],
  excludeKeywords: ["paliwo"],
  voivodeships: ["mazowieckie"],
  counties: [],
  active: true,
} satisfies CompanyProfileInput;

function storedProfile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    id: PROFILE_ID,
    ...validInput,
    createdAt: new Date("2026-10-01T08:00:00.000Z"),
    updatedAt: new Date("2026-10-01T08:00:00.000Z"),
    ...overrides,
  };
}

let sequence = 0;
function storedOffer(overrides: Partial<Opportunity> = {}): Opportunity {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sourceId: "bzp",
    sourceUrl: `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/${String(sequence)}`,
    externalId: `2026/BZP ${String(sequence)}`,
    tenderId: null,
    issuerName: "Gmina Przykładowa",
    title: "Modernizacja oświetlenia ulicznego",
    description: null,
    location: { voivodeship: "mazowieckie" },
    publishedAt: new Date("2026-10-20T08:00:00.000Z"),
    deadline: new Date("2026-11-05T11:00:00.000Z"),
    estimatedValue: null,
    currency: null,
    categories: ["45310000-3"],
    contact: { name: "Jan Kowalski", email: "kontakt@example.invalid", phone: "000 000 000" },
    fetchedAt: new Date("2026-10-20T09:00:00.000Z"),
    fingerprint: `fp-${String(sequence)}`,
    contentHash: `hash-${String(sequence)}`,
    status: "open",
    firstSeenAt: new Date("2026-10-20T09:00:00.000Z"),
    updatedAt: new Date("2026-10-20T09:00:00.000Z"),
    ...overrides,
  };
}

function stubDatabase(overrides: Partial<CliDatabase> = {}) {
  const calls = {
    opened: 0,
    closed: 0,
    created: [] as CompanyProfileInput[],
    limits: [] as number[],
  };
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    close: () => {
      calls.closed += 1;
      return Promise.resolve();
    },
    createCompanyProfile: (input) => {
      calls.created.push(input);
      return Promise.resolve(storedProfile());
    },
    getCompanyProfile: (id) => Promise.resolve(id === PROFILE_ID ? storedProfile() : null),
    listMatchCandidates: (limit) => {
      calls.limits.push(limit);
      return found([]);
    },
    ...overrides,
  };
  const deps = {
    openDatabase: () => {
      calls.opened += 1;
      return database;
    },
    sources: { ...defaultSourceDeps, now: () => NOW },
  };
  return { calls, deps };
}

async function run(
  args: string[],
  stub: ReturnType<typeof stubDatabase> = stubDatabase(),
  env: Record<string, string> = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { DATABASE_URL, ...env },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    stub.deps,
  );
  return { code, stdout, stderr, calls: stub.calls };
}

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "radar-profile-cli-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function profileFile(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe("profile:create", () => {
  it("creates the profile from a valid file and prints its id", async () => {
    const file = await profileFile("valid.json", JSON.stringify(validInput));
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok", id: PROFILE_ID });
    expect(result.stderr).toBe("");
    expect(result.calls.created).toEqual([validInput]);
    expect(result.calls.closed).toBe(1);
  });

  it("accepts the example profile from the README as it is", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const example = /### Przykładowy profil\n[\s\S]*?```json\n([\s\S]*?)```/u.exec(readme)?.[1];
    expect(example).toBeDefined();
    const parsed: unknown = JSON.parse(example ?? "");
    expect(companyProfileInputSchema.safeParse(parsed).success).toBe(true);
    expect(parsed).toMatchObject({ email: "kontakt@example.invalid" });
    const result = await run(["profile:create", await profileFile("readme.json", example ?? "")]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.created).toEqual([parsed]);
  });

  it("accepts other spellings of voivodeships and stores the canonical names", async () => {
    const file = await profileFile(
      "spelling.json",
      `\ufeff${JSON.stringify({ ...validInput, voivodeships: ["Woj. Mazowieckie", "SLASKIE"] })}`,
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.created[0]?.voivodeships).toEqual(["mazowieckie", "śląskie"]);
  });

  it.each([
    [[], 'Command "profile:create" needs a profile file (JSON).'],
    [["--file"], 'Command "profile:create" needs a profile file (JSON).'],
    [["a.json", "b.json"], 'Unexpected argument: "b.json"'],
  ])("rejects the arguments %j with exit 2", async (args, message) => {
    const result = await run(["profile:create", ...args]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Usage:");
    expect(result.calls.opened).toBe(0);
  });

  it("rejects a missing file without opening the database", async () => {
    const result = await run(["profile:create", join(dir, "missing.json")]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("Cannot open the profile file (ENOENT).\n");
    expect(result.calls.opened).toBe(0);
  });

  it("rejects a directory", async () => {
    const result = await run(["profile:create", dir]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("The profile file must be a regular file.\n");
  });

  it("rejects a file larger than 64 KiB before parsing it", async () => {
    const padded = JSON.stringify({ ...validInput, name: "x".repeat(PROFILE_FILE_MAX_BYTES) });
    const result = await run(["profile:create", await profileFile("big.json", padded)]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("The profile file is larger than 64 KiB.\n");
    expect(result.calls.opened).toBe(0);
  });

  it("accepts a file of exactly 64 KiB (it is then validated)", async () => {
    const base = JSON.stringify(validInput);
    const content = `${base}${" ".repeat(PROFILE_FILE_MAX_BYTES - Buffer.byteLength(base))}`;
    expect(Buffer.byteLength(content)).toBe(PROFILE_FILE_MAX_BYTES);
    const result = await run(["profile:create", await profileFile("edge.json", content)]);
    expect(result.code).toBe(ExitCode.Ok);
  });

  it("rejects invalid JSON without echoing the content", async () => {
    const file = await profileFile("broken.json", '{"email": "kontakt@example.invalid", ');
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("The profile file is not valid JSON.\n");
  });

  it("rejects a file that is not UTF-8", async () => {
    const file = await profileFile("latin2.json", new Uint8Array([0x7b, 0xb3, 0x7d]));
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("The profile file is not valid UTF-8.\n");
  });

  it("names the invalid fields and the allowed values, never the input values", async () => {
    const file = await profileFile(
      "invalid.json",
      JSON.stringify({
        ...validInput,
        email: "jan.kowalski-secret@",
        categories: ["elektryka", "tajna-kategoria"],
        voivodeships: ["Mazowsze-sekret"],
      }),
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe(
      "Invalid profile: email (Invalid email address), categories.1 (not an allowed value), " +
        `voivodeships.0 (not an allowed value). categories: one or more of ${MVP_CATEGORIES.join(", ")}. ` +
        "voivodeships: names of the 16 voivodeships (e.g. dolnośląskie, kujawsko-pomorskie).\n",
    );
    for (const secret of ["jan.kowalski-secret", "tajna-kategoria", "Mazowsze-sekret"]) {
      expect(result.stderr).not.toContain(secret);
    }
    expect(result.stdout).toBe("");
    expect(result.calls.opened).toBe(0);
  });

  it("requires at least one category", async () => {
    const file = await profileFile("empty.json", JSON.stringify({ ...validInput, categories: [] }));
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain(
      "Invalid profile: categories (Too small: expected array to have >=1 items). categories: ",
    );
  });

  it("says which fields are missing and shows hints only for invalid vocabulary fields", async () => {
    const file = await profileFile(
      "missing.json",
      JSON.stringify({
        name: 42,
        categories: validInput.categories,
        includeKeywords: ["!!!"],
        excludeKeywords: [],
        voivodeships: [],
        counties: [],
      }),
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe(
      "Invalid profile: email (missing), name (expected string), includeKeywords.0 " +
        "(must contain a letter or a digit), active (missing).\n",
    );
  });

  it("never shows a received value for a wrong type, even a non-finite number", async () => {
    // JSON.parse turns 1e999 into Infinity; zod's own message would say "received Infinity".
    const file = await profileFile(
      "infinity.json",
      JSON.stringify(validInput).replace('"Jan Kowalski Elektryka"', "1e999"),
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("Invalid profile: name (expected string).\n");
    expect(result.stderr).not.toContain("Infinity");
    expect(result.calls.opened).toBe(0);
  });

  it("shows at most five problems and counts the rest", async () => {
    const file = await profileFile(
      "many.json",
      JSON.stringify({ ...validInput, excludeKeywords: Array.from({ length: 7 }, () => "!!!") }),
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe(
      "Invalid profile: " +
        [0, 1, 2, 3, 4]
          .map((index) => `excludeKeywords.${String(index)} (must contain a letter or a digit)`)
          .join(", ") +
        " (+2 more).\n",
    );
  });

  it("rejects a county entry that is no county name", async () => {
    const file = await profileFile(
      "county.json",
      JSON.stringify({ ...validInput, counties: ["piaseczyński", "powiat"] }),
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("Invalid profile: counties.1 (not a county name).\n");
  });

  it("rejects a file that is not a profile object", async () => {
    const result = await run(["profile:create", await profileFile("array.json", "[1, 2]")]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("Invalid profile: (root) (expected object).\n");
  });

  it("names unknown fields and lists the allowed ones, never their values", async () => {
    const file = await profileFile(
      "unknown.json",
      JSON.stringify({ ...validInput, emial: "tajny@example.invalid", extra: { x: "tajne" } }),
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe(
      'Invalid profile: unknown field "emial", "extra". Allowed fields: email, name, ' +
        "categories, includeKeywords, excludeKeywords, voivodeships, counties, active.\n",
    );
    for (const secret of ["tajny@example.invalid", "tajne"]) {
      expect(result.stderr).not.toContain(secret);
    }
    expect(result.calls.opened).toBe(0);
  });

  it("cleans and cuts unknown field names and shows at most five", async () => {
    const hostile = `\u001b[2J${"x".repeat(60)}`;
    const extra = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((key) => [key, 1]));
    const file = await profileFile(
      "unknown-many.json",
      JSON.stringify({ ...validInput, [hostile]: 1, ...extra }),
    );
    const result = await run(["profile:create", file]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).not.toContain("\u001b");
    expect(result.stderr).toContain(`"[2J${"x".repeat(37)}…", "a", "b", "c", "d" (+2 more).`);
  });

  it("refuses a FIFO at once instead of waiting for a writer", async (context) => {
    const fifo = join(dir, "profile.fifo");
    try {
      await promisify(execFile)("mkfifo", [fifo]);
    } catch {
      context.skip("mkfifo is not available on this platform");
    }
    const started = performance.now();
    const result = await run(["profile:create", fifo]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("The profile file must be a regular file.\n");
    expect(result.calls.opened).toBe(0);
  });

  it("follows a symlink to a regular file; a dangling one is a missing file", async () => {
    const target = await profileFile("target.json", JSON.stringify(validInput));
    const link = join(dir, "link.json");
    await symlink(target, link);
    expect((await run(["profile:create", link])).code).toBe(ExitCode.Ok);
    const dangling = join(dir, "dangling.json");
    await symlink(join(dir, "nothing-here.json"), dangling);
    const result = await run(["profile:create", dangling]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toBe("Cannot open the profile file (ENOENT).\n");
  });

  it("exits 1 with a clear message when the e-mail is already used", async () => {
    const stub = stubDatabase({
      createCompanyProfile: () =>
        Promise.reject(
          new DomainError("duplicate", "Duplicate value (company_profiles_email_key)", []),
        ),
    });
    const file = await profileFile("dup.json", JSON.stringify(validInput));
    const result = await run(["profile:create", file], stub);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Profile not created: a profile with this e-mail already exists\n");
    expect(result.stderr).not.toContain("kontakt@example.invalid");
    expect(result.calls.closed).toBe(1);
  });

  it("reports a database failure with a fixed reason only", async () => {
    const failure = Object.assign(new Error(`connect ECONNREFUSED ${DATABASE_URL}`), {
      code: "ECONNREFUSED",
    });
    const stub = stubDatabase({ createCompanyProfile: () => Promise.reject(failure) });
    const file = await profileFile("down.json", JSON.stringify(validInput));
    const result = await run(["profile:create", file], stub);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Profile not created: database unreachable (ECONNREFUSED)\n");
  });

  it("turns an unexpected error into the internal error message", async () => {
    const stub = stubDatabase({
      createCompanyProfile: () => Promise.reject(new Error("kontakt@example.invalid boom")),
    });
    const file = await profileFile("bug.json", JSON.stringify(validInput));
    const result = await run(["profile:create", file], stub);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(INTERNAL_ERROR_MESSAGE);
    expect(result.calls.closed).toBe(1);
  });

  it("checks the file before the configuration", async () => {
    const result = await run(["profile:create", join(dir, "missing.json")], stubDatabase(), {
      LOG_LEVEL: "bogus",
    });
    expect(result.code).toBe(ExitCode.Usage);
  });
});

describe("profile:show", () => {
  it("prints the profile as JSON", async () => {
    const result = await run(["profile:show", PROFILE_ID]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      ...validInput,
      id: PROFILE_ID,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-01T08:00:00.000Z",
    });
    expect(result.calls.closed).toBe(1);
  });

  it.each([[[]], [["not-a-uuid"]], [[PROFILE_ID, "extra"]]])(
    "rejects the arguments %j with exit 2",
    async (args) => {
      const result = await run(["profile:show", ...args]);
      expect(result.code).toBe(ExitCode.Usage);
      expect(result.calls.opened).toBe(0);
    },
  );

  it("exits 1 for an unknown id", async () => {
    const result = await run(["profile:show", "6f1c2a52-6d3e-4c55-9a4b-2f7c3f1d9e02"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Profile not found.\n");
    expect(result.stdout).toBe("");
  });

  it("exits 1 for a stored profile that no longer satisfies the schema", async () => {
    const stub = stubDatabase({
      getCompanyProfile: () =>
        Promise.reject(
          new DomainError(
            "invalid_stored_row",
            `Stored company profile ${PROFILE_ID} does not match the domain schema: categories`,
            ["categories"],
            null,
            PROFILE_ID,
          ),
        ),
    });
    const result = await run(["profile:show", PROFILE_ID], stub);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      `Cannot read the profile: Stored company profile ${PROFILE_ID} does not match the domain schema: categories (invalid_stored_row)\n`,
    );
  });
});

describe("match:preview", () => {
  it.each([
    [[], 'Command "match:preview" needs a profile id (uuid).'],
    [["nope"], 'Command "match:preview" needs a profile id (uuid).'],
    [[PROFILE_ID, "--limit"], "Option --limit needs a value."],
    [[PROFILE_ID, "--limit", "0"], "--limit must be an integer from 1 to 1000."],
    [[PROFILE_ID, "--limit", "1001"], "--limit must be an integer from 1 to 1000."],
    [[PROFILE_ID, "--limit", "01"], "--limit must be an integer from 1 to 1000."],
    [[PROFILE_ID, "--limit", "5", "--limit", "6"], "Option --limit given twice."],
    [[PROFILE_ID, "--since", "x"], 'Unexpected argument: "--since"'],
  ])("rejects the arguments %j with exit 2", async (args, message) => {
    const result = await run(["match:preview", ...args]);
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain(message);
    expect(result.calls.opened).toBe(0);
  });

  it.each([
    [[], 100],
    [["--limit", "1"], 1],
    [["--limit", "1000"], 1000],
  ])("reads the offers with %j → limit %d", async (options, limit) => {
    const result = await run(["match:preview", PROFILE_ID, ...options]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.limits).toEqual([limit]);
    expect(result.stdout).toBe(
      `Profil: Jan Kowalski Elektryka (${PROFILE_ID})\n\ndopasowane 0 z 0\n`,
    );
  });

  it("exits 1 for an unknown profile without reading offers", async () => {
    const result = await run(["match:preview", "6f1c2a52-6d3e-4c55-9a4b-2f7c3f1d9e02"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Profile not found.\n");
    expect(result.calls.limits).toEqual([]);
    expect(result.calls.closed).toBe(1);
  });

  it("prints matched offers by deadline, then score, with reasons and the summary", async () => {
    const later = storedOffer({
      title: "Oświetlenie hali sportowej",
      deadline: new Date("2026-11-20T11:00:00.000Z"),
    });
    const sooner = storedOffer({
      title: "Modernizacja oświetlenia ulicznego",
      deadline: new Date("2026-11-05T11:00:00.000Z"),
    });
    const noDeadline = storedOffer({ title: "Oświetlenie parku", deadline: null });
    const sameDeadlineHigherScore = storedOffer({
      title: "Oświetlenie i monitoring szkoły",
      deadline: new Date("2026-11-20T11:00:00.000Z"),
    });
    const excluded = storedOffer({ title: "Oświetlenie oraz dostawa paliwa" });
    const elsewhere = storedOffer({ location: { voivodeship: "śląskie" } });
    const candidates = [noDeadline, later, excluded, sameDeadlineHigherScore, sooner, elsewhere];
    const stub = stubDatabase({
      getCompanyProfile: () =>
        Promise.resolve(storedProfile({ includeKeywords: ["oświetlenie", "monitoring"] })),
      listMatchCandidates: () => found(candidates),
    });
    const result = await run(["match:preview", PROFILE_ID], stub);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stderr).toBe("");
    const titles = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("["))
      .map((line) => line.replace(/^\[\d+\] /u, ""));
    expect(titles).toEqual([
      "Modernizacja oświetlenia ulicznego",
      "Oświetlenie i monitoring szkoły",
      "Oświetlenie hali sportowej",
      "Oświetlenie parku",
    ]);
    expect(result.stdout).toContain(
      [
        "[90] Modernizacja oświetlenia ulicznego",
        "  zamawiający: Gmina Przykładowa",
        "  termin: 2026-11-05 12:00",
        `  link: ${sooner.sourceUrl}`,
        "  dlaczego: kategoria: elektryka (CPV 45310000-3); słowo: oświetlenie (tytuł); region: mazowieckie",
      ].join("\n"),
    );
    expect(result.stdout).toContain("[100] Oświetlenie i monitoring szkoły");
    expect(result.stdout).toContain("  termin: brak terminu");
    expect(result.stdout.endsWith("\ndopasowane 4 z 6\n")).toBe(true);
    expect(result.stdout).not.toContain("Uwaga");
  });

  it("never prints the offers' contact data", async () => {
    const stub = stubDatabase({
      listMatchCandidates: () => found([storedOffer()]),
    });
    const result = await run(["match:preview", PROFILE_ID], stub);
    expect(result.stdout).toContain("dopasowane 1 z 1");
    for (const contact of ["Jan Kowalski", "kontakt@example.invalid", "000 000 000"]) {
      expect(result.stdout.replace("Profil: Jan Kowalski Elektryka", "")).not.toContain(contact);
    }
  });

  it("previews an inactive profile, saying that it is inactive", async () => {
    const stub = stubDatabase({
      getCompanyProfile: () => Promise.resolve(storedProfile({ active: false })),
      listMatchCandidates: () => found([storedOffer()]),
    });
    const result = await run(["match:preview", PROFILE_ID], stub);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain(
      "Uwaga: profil jest nieaktywny — nie dostaje powiadomień; to tylko podgląd.",
    );
    expect(result.stdout).toContain("dopasowane 1 z 1");
  });

  it("strips control characters from source text before printing", async () => {
    const stub = stubDatabase({
      listMatchCandidates: () =>
        found([
          storedOffer({
            title: "Oświetlenie\u001b[2J\u001b]0;x\u0007 ulic\u202e",
            issuerName: "Gmina\u0000X",
          }),
        ]),
    });
    const result = await run(["match:preview", PROFILE_ID], stub);
    expect(result.code).toBe(ExitCode.Ok);
    // eslint-disable-next-line no-control-regex -- the point of the test
    expect(result.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/u);
    expect(result.stdout).toContain("zamawiający: Gmina X");
  });

  it("reports a database failure while reading offers with a fixed reason", async () => {
    const failure = Object.assign(new Error(`connect ECONNREFUSED ${DATABASE_URL}`), {
      code: "ECONNREFUSED",
    });
    const stub = stubDatabase({ listMatchCandidates: () => Promise.reject(failure) });
    const result = await run(["match:preview", PROFILE_ID], stub);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Cannot read offers: database unreachable (ECONNREFUSED)\n");
    expect(result.stderr).not.toContain("not-a-real-password");
    expect(result.calls.closed).toBe(1);
  });

  it("lists offers past their deadline last, marked, and keeps them", async () => {
    const past = storedOffer({
      title: "Oświetlenie przedszkola",
      deadline: new Date("2026-10-24T10:00:00.000Z"),
    });
    const pastEarlier = storedOffer({
      title: "Oświetlenie stadionu",
      deadline: new Date("2026-10-01T10:00:00.000Z"),
    });
    const future = storedOffer({
      title: "Oświetlenie hali sportowej",
      deadline: new Date("2026-11-20T11:00:00.000Z"),
    });
    const noDeadline = storedOffer({ title: "Oświetlenie parku", deadline: null });
    const atNow = storedOffer({ title: "Oświetlenie mostu", deadline: NOW });
    const stub = stubDatabase({
      listMatchCandidates: () => found([past, noDeadline, pastEarlier, future, atNow]),
    });
    const result = await run(["match:preview", PROFILE_ID], stub);
    expect(result.code).toBe(ExitCode.Ok);
    const titles = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("["))
      .map((line) => line.replace(/^\[\d+\] /u, ""));
    expect(titles).toEqual([
      "Oświetlenie mostu",
      "Oświetlenie hali sportowej",
      "Oświetlenie parku",
      "Oświetlenie stadionu",
      "Oświetlenie przedszkola",
    ]);
    expect(result.stdout).toContain(
      "[90] Oświetlenie stadionu\n  zamawiający: Gmina Przykładowa\n" +
        "  termin: 2026-10-01 12:00 (po terminie)\n",
    );
    expect(result.stdout).toContain("  termin: 2026-10-24 12:00 (po terminie)\n");
    // A deadline equal to "now" has not passed yet.
    expect(result.stdout).toContain("  termin: 2026-10-25 09:00\n");
    expect(result.stdout.match(/\(po terminie\)/gu)).toHaveLength(2);
    expect(result.stdout.endsWith("\ndopasowane 5 z 5\n")).toBe(true);
  });

  it.each([
    [1, "pominięto 1 nieprawidłowy wiersz"],
    [2, "pominięto 2 nieprawidłowe wiersze"],
    [5, "pominięto 5 nieprawidłowych wierszy"],
    [12, "pominięto 12 nieprawidłowych wierszy"],
    [22, "pominięto 22 nieprawidłowe wiersze"],
  ])("skips %d invalid stored rows with a warning each and exits 0", async (count, summary) => {
    const skipped = Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
      fields: ["location.voivodeship"],
    }));
    const stub = stubDatabase({ listMatchCandidates: () => found([storedOffer()], skipped) });
    const result = await run(["match:preview", PROFILE_ID], stub);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout.endsWith(`\ndopasowane 1 z 1, ${summary}\n`)).toBe(true);
    const warnings = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(warnings).toHaveLength(count);
    expect(warnings[0]).toMatchObject({
      level: "warn",
      message: "match:preview skipped an invalid stored offer",
      rowId: skipped[0]?.id,
      fields: ["location.voivodeship"],
    });
  });
});

describe("formatWarsawMinute", () => {
  it("shows Poland's wall-clock time in winter and summer", () => {
    expect(formatWarsawMinute(new Date("2026-11-05T11:00:00.000Z"))).toBe("2026-11-05 12:00");
    expect(formatWarsawMinute(new Date("2026-07-01T22:30:00.000Z"))).toBe("2026-07-02 00:30");
  });
});

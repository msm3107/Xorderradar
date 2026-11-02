import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoPgConnectionEnv,
  backupFileName,
  BackupError,
  classifyToolFailure,
  dumpSchema,
  isPlainSchemaName,
  PG_CONNECTION_ENV_VARS,
  pgToolConnection,
  pgToolEnv,
  restoreSchema,
  runTool,
} from "../src/operations/backup.js";

// A distinctive fake password: it must show up in PGPASSWORD and nowhere else.
const PASSWORD = "Zx9-not-a-real-db-password";

function failure(fn: () => unknown): BackupError {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BackupError);
    return error as BackupError;
  }
  throw new Error("no error");
}

async function rejection(promise: Promise<unknown>): Promise<BackupError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BackupError);
  return error as BackupError;
}

describe("pgToolConnection", () => {
  it("maps the URL to a conninfo without the password", () => {
    const connection = pgToolConnection(
      `postgres://radar:${PASSWORD}@db.example.invalid:5433/radar?options=-c%20search_path%3Dradar_app`,
    );
    expect(connection).toEqual({
      conninfo:
        "host='db.example.invalid' port='5433' dbname='radar' user='radar' " +
        "options='-c search_path=radar_app' sslmode='disable'",
      password: PASSWORD,
    });
    expect(connection.conninfo).not.toContain(PASSWORD);
  });

  it("decodes percent-encoded parts and quotes values the libpq way", () => {
    const connection = pgToolConnection(
      `postgresql://ra%27dar:p%40ss@db.example.invalid/my%20db?application_name=a%5Cb`,
    );
    expect(connection.conninfo).toBe(
      "host='db.example.invalid' port='5432' dbname='my db' user='ra\\'dar' sslmode='disable'",
    );
    expect(connection.password).toBe("p@ss");
  });

  it("defaults to localhost:5432 and has no password when there is none", () => {
    expect(pgToolConnection("postgres:///radar")).toEqual({
      conninfo: "host='localhost' port='5432' dbname='radar' sslmode='disable'",
      password: null,
    });
  });

  it("lets query parameters win over the URL's parts, as pg does", () => {
    const connection = pgToolConnection(
      `postgres://radar:x@db.example.invalid:5432/radar?host=other.example.invalid&port=6432&user=app&password=${PASSWORD}`,
    );
    expect(connection.conninfo).toBe(
      "host='other.example.invalid' port='6432' dbname='radar' user='app' sslmode='disable'",
    );
    expect(connection.password).toBe(PASSWORD);
  });

  it.each([
    ["sslmode=disable", "sslmode='disable'"],
    ["ssl=0", "sslmode='disable'"],
    ["sslmode=no-verify", "sslmode='require'"],
    ["sslmode=require", "sslmode='verify-full' sslrootcert='system'"],
    ["sslmode=prefer", "sslmode='verify-full' sslrootcert='system'"],
    ["sslmode=verify-ca", "sslmode='verify-full' sslrootcert='system'"],
    ["ssl=true", "sslmode='verify-full' sslrootcert='system'"],
    ["ssl=1", "sslmode='verify-full' sslrootcert='system'"],
    ["sslrootcert=/etc/radar/ca.pem", "sslmode='verify-full' sslrootcert='/etc/radar/ca.pem'"],
  ])("maps pg's TLS setting %s to %s (never weaker than pg)", (query, tls) => {
    expect(pgToolConnection(`postgres://radar@db.example.invalid/radar?${query}`).conninfo).toBe(
      `host='db.example.invalid' port='5432' dbname='radar' user='radar' ${tls}`,
    );
  });

  it.each([
    ["postgres://radar@db.example.invalid/radar?sslmode=allow", "sslmode"],
    ["postgres://radar@db.example.invalid/radar?ssl=maybe", "ssl"],
    ["postgres://radar@db.example.invalid/radar?connect_timeout=5", "connect_timeout"],
    ["postgres://radar@db.example.invalid/radar?port=0", "port"],
    // A key that is not plain is not named.
    ["postgres://radar@db.example.invalid/radar?X-Secret=1", null],
    ["mysql://radar@db.example.invalid/radar", null],
    ["not a url", null],
    ["postgres://radar@db.example.invalid/radar?options=-c%0Asearch_path%3Dx", null],
  ])("refuses %s as unsupported (naming %s)", (url, key) => {
    const error = failure(() => pgToolConnection(url));
    expect(error.reason).toBe("unsupported_database_url");
    expect(error.detail).toBe(key);
  });
});

describe("pgToolEnv", () => {
  it("passes PATH, HOME and the password, and nothing else from the environment", () => {
    expect(
      pgToolEnv(
        {
          PATH: "/usr/bin",
          HOME: "/home/radar",
          DATABASE_URL: `postgres://radar:${PASSWORD}@db.example.invalid/radar`,
          PGHOST: "elsewhere.example.invalid",
          PGPASSWORD: "other",
          SMTP_URL: "smtps://user:secret@smtp.example.invalid",
        },
        PASSWORD,
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/radar",
      PGPASSWORD: PASSWORD,
      PGCONNECT_TIMEOUT: "10",
      PGAPPNAME: "radar-zamowien",
      LC_ALL: "C",
    });
  });

  it("sets no PGPASSWORD without a password", () => {
    expect(pgToolEnv({}, null)).not.toHaveProperty("PGPASSWORD");
  });
});

describe("assertNoPgConnectionEnv", () => {
  // `pg` would use these where DATABASE_URL is silent; the tools would not.
  const VALUE = "Qw7-elsewhere.example.invalid";

  it.each(PG_CONNECTION_ENV_VARS)("refuses %s, naming the variable and not its value", (name) => {
    const error = failure(() => {
      assertNoPgConnectionEnv({ PATH: "/usr/bin", [name]: VALUE });
    });
    expect(error.reason).toBe("unsupported_database_url");
    expect(error.detail).toBe(name);
    expect(error.message).toBe(`unsupported_database_url (${name})`);
    expect(`${error.message} ${String(error.detail)}`).not.toContain(VALUE);
  });

  it("covers every variable pg reads for a connection setting", () => {
    expect([...PG_CONNECTION_ENV_VARS].sort()).toEqual([
      "PGDATABASE",
      "PGHOST",
      "PGHOSTADDR",
      "PGOPTIONS",
      "PGPASSWORD",
      "PGPORT",
      "PGSSLMODE",
      "PGSSLNEGOTIATION",
      "PGUSER",
    ]);
  });

  it("passes a clean environment, empty values and unrelated PG variables", () => {
    expect(() => {
      assertNoPgConnectionEnv({});
    }).not.toThrow();
    expect(() => {
      assertNoPgConnectionEnv({
        PATH: "/usr/bin",
        HOME: "/home/radar",
        DATABASE_URL: `postgres://radar:${PASSWORD}@db.example.invalid/radar`,
        PGHOST: "",
        PGSSLMODE: "",
        PGUSER: undefined,
        PGAPPNAME: "other",
      });
    }).not.toThrow();
  });
});

describe("isPlainSchemaName", () => {
  it.each([
    ["public", true],
    ["radar_app", true],
    ["test_0a1b", true],
    ["Radar", false],
    ["radar-app", false],
    ["radar*", false],
    ["1radar", false],
    ["", false],
    ["a".repeat(64), false],
  ])("%j → %s", (name, plain) => {
    expect(isPlainSchemaName(name)).toBe(plain);
  });
});

describe("classifyToolFailure", () => {
  it.each([
    ["pg_dump: error: aborting because of server version mismatch", "version_mismatch"],
    ["pg_restore: error: unsupported version (1.16) in file header", "version_mismatch"],
    ['FATAL:  password authentication failed for user "radar"', "authentication_failed"],
    ["fe_sendauth: no password supplied", "authentication_failed"],
    ['connection to server at "127.0.0.1", port 1 failed: Connection refused', "unreachable"],
    ['could not translate host name "db.example.invalid" to address', "unreachable"],
    ["timeout expired", "unreachable"],
    [
      'pg_restore: error: could not execute query: ERROR:  relation "x" already exists',
      "tool_failed",
    ],
    ["", "tool_failed"],
  ])("%j → %s", (stderr, reason) => {
    expect(classifyToolFailure(stderr)).toBe(reason);
  });
});

describe("backupFileName", () => {
  it("is radar-<UTC time>.dump", () => {
    expect(backupFileName(new Date("2026-11-02T07:05:09.123Z"))).toBe(
      "radar-20261102T070509Z.dump",
    );
  });
});

describe("runTool", () => {
  const base = {
    env: { PATH: process.env.PATH ?? "" },
    stdin: "ignore",
    stdout: "ignore",
  } as const;

  it("resolves when the tool exits 0", async () => {
    await runTool({ ...base, command: "true", args: [], timeoutMs: 10_000, killGraceMs: 1_000 });
  });

  it("classifies a non-zero exit by its stderr, which is never shown", async () => {
    const error = await rejection(
      runTool({
        ...base,
        command: "sh",
        args: ["-c", `echo "password authentication failed ${PASSWORD}" >&2; exit 3`],
        timeoutMs: 10_000,
        killGraceMs: 1_000,
      }),
    );
    expect(error.reason).toBe("authentication_failed");
    expect(error.detail).toBe("exit 3");
    expect(error.message).not.toContain(PASSWORD);
  });

  it("stops a tool over its time limit, killing it when it ignores SIGTERM", async () => {
    const started = Date.now();
    const error = await rejection(
      runTool({
        ...base,
        command: "sh",
        args: ["-c", "trap '' TERM; while :; do sleep 0.05; done"],
        timeoutMs: 100,
        killGraceMs: 100,
      }),
    );
    expect(error.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a tool that is not on PATH", async () => {
    const error = await rejection(
      runTool({
        ...base,
        env: { PATH: "" },
        command: "pg_dump",
        args: [],
        timeoutMs: 10_000,
        killGraceMs: 1_000,
      }),
    );
    expect(error.reason).toBe("tool_not_found");
  });
});

describe("dumpSchema and restoreSchema without the tools", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "radar-backup-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const url = `postgres://radar:${PASSWORD}@127.0.0.1:1/radar`;
  const now = new Date("2026-11-02T07:00:00.000Z");

  it("leaves nothing behind when pg_dump is not found", async () => {
    const error = await rejection(dumpSchema(url, "public", dir, now, { env: { PATH: "" } }));
    expect(error.reason).toBe("tool_not_found");
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a directory that does not exist, and a schema name that is not plain", async () => {
    const missing = join(dir, "missing");
    expect(
      (await rejection(dumpSchema(url, "public", missing, now, { env: { PATH: "" } }))).reason,
    ).toBe("not_a_directory");
    expect(
      (await rejection(dumpSchema(url, "radar*", dir, now, { env: { PATH: "" } }))).reason,
    ).toBe("invalid_schema");
  });

  it("never replaces an existing backup", async () => {
    const existing = join(dir, backupFileName(now));
    await writeFile(existing, "old");
    // A fake pg_dump that succeeds without output: the link then finds the file.
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pg_dump"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "pg_dump"), 0o700);
    const error = await rejection(
      dumpSchema(url, "public", dir, now, { env: { PATH: `${bin}:/usr/bin:/bin` } }),
    );
    expect(error.reason).toBe("file_exists");
    expect((await readdir(dir)).sort()).toEqual(["bin", backupFileName(now)]);
    await rm(existing);
    await rm(bin, { recursive: true });
  });

  it("refuses a PG* connection variable before writing or running anything", async () => {
    const env = { PATH: "", PGHOSTADDR: "192.0.2.1" };
    const dumped = await rejection(dumpSchema(url, "public", dir, now, { env }));
    expect([dumped.reason, dumped.detail]).toEqual(["unsupported_database_url", "PGHOSTADDR"]);
    expect(await readdir(dir)).toEqual([]);
    const restored = await rejection(
      restoreSchema(url, "public", join(dir, "missing.dump"), { env }),
    );
    expect([restored.reason, restored.detail]).toEqual(["unsupported_database_url", "PGHOSTADDR"]);
  });

  it("refuses a backup file that does not exist or is a directory", async () => {
    for (const path of [join(dir, "missing.dump"), dir]) {
      const error = await rejection(restoreSchema(url, "public", path, { env: { PATH: "" } }));
      expect(error.reason).toBe("not_a_file");
    }
  });
});

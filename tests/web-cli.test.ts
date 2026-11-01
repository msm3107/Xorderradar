import { describe, expect, it } from "vitest";
import { ExitCode, runCli, type CliDatabase, type CliWebDeps } from "../src/cli.js";
import type { WebServerOptions } from "../src/web/server.js";

const DATABASE_URL = "postgres://radar:not-a-real-password@db.example.invalid:5432/radar";
const BASE = "https://radar.example.invalid";
const PROFILE_ID = "00000000-0000-4000-8000-0000000000aa";
const TOKEN = "t".repeat(43);

/**
 * `serve` and `access:link` with a database stub; the real server and
 * tokens are covered by tests/web-server.test.ts and
 * tests/integration/web.test.ts.
 */
async function run(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    pending?: string[];
    listenError?: Error;
    profileExists?: boolean;
    revokeError?: Error;
  } = {},
) {
  const calls = {
    closed: 0,
    started: [] as Omit<WebServerOptions, "db">[],
    serverClosed: 0,
    issued: [] as string[],
    revoked: [] as string[],
  };
  let stop = (): void => undefined;
  const database: CliDatabase = {
    ping: () => Promise.resolve(),
    migrate: () => Promise.resolve([]),
    pendingMigrations: () => Promise.resolve(options.pending ?? []),
    close: () => {
      calls.closed++;
      return Promise.resolve();
    },
    startWebServer: (webOptions) => {
      calls.started.push(webOptions);
      if (options.listenError !== undefined) return Promise.reject(options.listenError);
      // The stub "runs" until the shutdown signal, given right after it starts.
      setImmediate(stop);
      return Promise.resolve({
        host: webOptions.host,
        port: webOptions.port,
        close: () => {
          calls.serverClosed++;
          return Promise.resolve();
        },
      });
    },
    issueLoginToken: (profileId) => {
      calls.issued.push(profileId);
      return Promise.resolve(
        options.profileExists === false
          ? null
          : { token: TOKEN, expiresAt: new Date("2026-11-08T06:00:00.000Z") },
      );
    },
    revokeProfileAccess: (profileId) => {
      calls.revoked.push(profileId);
      if (options.revokeError !== undefined) return Promise.reject(options.revokeError);
      return Promise.resolve(options.profileExists === false ? null : { tokens: 3, sessions: 2 });
    },
  };
  const web: CliWebDeps = {
    waitForShutdown: () =>
      new Promise((resolve) => {
        stop = resolve;
      }),
  };
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      env: { DATABASE_URL, ...options.env },
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    { openDatabase: () => database, web },
  );
  expect(stdout + stderr).not.toContain("not-a-real-password");
  return { code, stdout, stderr, calls };
}

describe("serve", () => {
  it("listens on the configured address and shuts down on the signal", async () => {
    const result = await run(["serve"], {
      env: { PUBLIC_BASE_URL: BASE, WEB_PORT: "8080", LOG_LEVEL: "info" },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.started).toHaveLength(1);
    expect(result.calls.started[0]).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      publicBaseUrl: BASE,
    });
    expect(result.calls.serverClosed).toBe(1);
    expect(result.calls.closed).toBe(1);
    expect(result.stdout).toBe("");
    const messages = result.stderr
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { message: string }).message);
    expect(messages).toEqual(["web server listening", "web server stopping", "web server stopped"]);
  });

  it("requires PUBLIC_BASE_URL before opening the database (exit 1)", async () => {
    const result = await run(["serve"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Invalid web configuration: PUBLIC_BASE_URL\n");
    expect(result.calls.closed).toBe(0);
  });

  it("refuses an http PUBLIC_BASE_URL that is not loopback", async () => {
    const result = await run(["serve"], {
      env: { PUBLIC_BASE_URL: "http://radar.example.invalid" },
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Invalid web configuration: PUBLIC_BASE_URL\n");
  });

  it("does not start on an outdated schema", async () => {
    const result = await run(["serve"], {
      env: { PUBLIC_BASE_URL: BASE },
      pending: ["0006_access"],
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Serve failed: the database schema is not up to date; run `migrate`.\n",
    );
    expect(result.calls.started).toHaveLength(0);
    expect(result.calls.closed).toBe(1);
  });

  it("exits 1 when the address cannot be bound, naming the code only", async () => {
    const error = Object.assign(new Error("listen EADDRINUSE: address 127.0.0.1:3000"), {
      code: "EADDRINUSE",
    });
    const result = await run(["serve"], { env: { PUBLIC_BASE_URL: BASE }, listenError: error });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe("Serve failed: cannot listen on WEB_HOST:WEB_PORT (EADDRINUSE).\n");
    expect(result.calls.closed).toBe(1);
  });

  it("takes no arguments", async () => {
    const result = await run(["serve", "--port", "1"], { env: { PUBLIC_BASE_URL: BASE } });
    expect(result.code).toBe(ExitCode.Usage);
    expect(result.stderr).toContain('Command "serve" takes no arguments.');
  });
});

describe("access:link", () => {
  it("prints a login link as one JSON line and warns that it is a secret", async () => {
    const result = await run(["access:link", PROFILE_ID], { env: { PUBLIC_BASE_URL: BASE } });
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "ok",
      url: `${BASE}/dostep/${TOKEN}`,
      expiresAt: "2026-11-08T06:00:00.000Z",
    });
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(result.stderr).toContain("The link is a secret");
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.calls.issued).toEqual([PROFILE_ID]);
    expect(result.calls.closed).toBe(1);
  });

  it("exits 1 for a profile that does not exist", async () => {
    const result = await run(["access:link", PROFILE_ID], {
      env: { PUBLIC_BASE_URL: BASE },
      profileExists: false,
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Profile not found.\n");
  });

  it("requires PUBLIC_BASE_URL (exit 1) without opening the database", async () => {
    const result = await run(["access:link", PROFILE_ID]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "PUBLIC_BASE_URL is required for access:link (the links are built from it).\n",
    );
    expect(result.calls.closed).toBe(0);
  });

  it("does not issue on an outdated schema", async () => {
    const result = await run(["access:link", PROFILE_ID], {
      env: { PUBLIC_BASE_URL: BASE },
      pending: ["0006_access"],
    });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.calls.issued).toEqual([]);
  });

  it.each([[[]], [["nie-uuid"]], [[PROFILE_ID, "extra"]], [["--profile", PROFILE_ID]]])(
    "is a usage error for %j (exit 2)",
    async (rest) => {
      const result = await run(["access:link", ...rest], { env: { PUBLIC_BASE_URL: BASE } });
      expect(result.code).toBe(ExitCode.Usage);
      expect(result.calls.issued).toEqual([]);
    },
  );
});

describe("access:revoke", () => {
  it("prints the counts as one JSON line and nothing secret", async () => {
    const result = await run(["access:revoke", PROFILE_ID]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok", tokens: 3, sessions: 2 });
    expect(result.stdout.split("\n")).toHaveLength(2);
    expect(result.stderr).toBe("");
    expect(result.calls.revoked).toEqual([PROFILE_ID]);
    expect(result.calls.issued).toEqual([]);
    expect(result.calls.closed).toBe(1);
  });

  it("does not need PUBLIC_BASE_URL", async () => {
    const result = await run(["access:revoke", PROFILE_ID], {
      env: { PUBLIC_BASE_URL: undefined },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.calls.revoked).toEqual([PROFILE_ID]);
  });

  it("exits 1 for a profile that does not exist", async () => {
    const result = await run(["access:revoke", PROFILE_ID], { profileExists: false });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Profile not found.\n");
  });

  it("exits 1 naming only the reason and code when the database is unreachable", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    const result = await run(["access:revoke", PROFILE_ID], { revokeError: refused });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Access not revoked: database unreachable (ECONNREFUSED)\n");
    expect(result.stderr).not.toContain("127.0.0.1");
    expect(result.calls.closed).toBe(1);
  });

  it("does not revoke on an outdated schema", async () => {
    const result = await run(["access:revoke", PROFILE_ID], { pending: ["0006_access"] });
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stderr).toBe(
      "Access not revoked: the database schema is not up to date; run `migrate`.\n",
    );
    expect(result.calls.revoked).toEqual([]);
    expect(result.calls.closed).toBe(1);
  });

  it.each([[[]], [["nie-uuid"]], [[PROFILE_ID, "extra"]], [["--profile", PROFILE_ID]]])(
    "is a usage error for %j (exit 2) without opening the database",
    async (rest) => {
      const result = await run(["access:revoke", ...rest]);
      expect(result.code).toBe(ExitCode.Usage);
      expect(result.stderr).toContain("Usage:");
      expect(result.calls.revoked).toEqual([]);
      expect(result.calls.closed).toBe(0);
    },
  );

  it("is listed in the help text", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain("access:revoke <profileId>");
    expect(result.stdout).toContain("The profile and its notifications stay as they are");
  });
});

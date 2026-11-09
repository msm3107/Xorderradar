import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadConfig,
  loadContactEmail,
  loadEmailConfig,
  loadOperatorEmail,
  loadPublicBaseUrl,
  loadStatusConfig,
  loadWebConfig,
} from "../src/infrastructure/config.js";
import { PROFILE_FORM_MAX_BYTES } from "../src/web/server.js";

/*
 * PR-07B: the deployment artifacts under deploy/ agree with each other, with
 * the application's configuration and with the runbook. Nothing here talks
 * to systemd, cron, Caddy or the network.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const UNIT = read("deploy/systemd/radar-serve.service");
const SMTP_DROP_IN = read("deploy/systemd/radar-serve.service.d/smtp.conf");
const CRON = read("deploy/cron/radar");
const LOGROTATE = read("deploy/logrotate/radar");
const CADDYFILE = read("deploy/caddy/Caddyfile");
const ENV_EXAMPLE = read("deploy/radar.env.example");

/** KEY=value lines of a systemd unit (comments and sections left out); repeated keys in order. */
function unitEntries(text: string): [string, string][] {
  return text
    .split("\n")
    .filter((line) => /^[A-Za-z]+=/.test(line))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    });
}

function unitValue(key: string): string | undefined {
  return unitEntries(UNIT).find(([name]) => name === key)?.[1];
}

/** The job lines of the cron file: five time fields, the user, the command. */
function cronJobs(): { minute: string; hour: string; user: string; command: string }[] {
  return CRON.split("\n")
    .filter((line) => /^[0-9*]/.test(line))
    .map((line) => {
      const match = /^(\S+) (\S+) \* \* \* (\S+) (.+)$/.exec(line);
      if (match === null) throw new Error(`unexpected cron line: ${line}`);
      const [, minute = "", hour = "", user = "", command = ""] = match;
      return { minute, hour, user, command };
    });
}

const ENV = parseEnv(ENV_EXAMPLE) as Record<string, string>;

describe("deploy/radar.env.example", () => {
  it("means the same to Node's --env-file and to systemd's EnvironmentFile=", () => {
    // A plain KEY=value split, as both parsers read an unquoted, unescaped line.
    const plain = Object.fromEntries(
      ENV_EXAMPLE.split("\n")
        .filter((line) => line !== "" && !line.startsWith("#"))
        .map((line) => {
          expect(line).toMatch(/^[A-Z][A-Z0-9_]*=/);
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    expect(ENV).toEqual(plain);
    for (const value of Object.values(plain)) {
      expect(value).not.toMatch(/["'`#$\\]/);
      expect(value).toBe(value.trim());
    }
  });

  it("is accepted by every configuration loader in production, also with smtp", () => {
    expect(ENV.NODE_ENV).toBe("production");
    expect(() => loadConfig(ENV)).not.toThrow();
    expect(loadEmailConfig(ENV).mode).toBe("test");
    expect(loadEmailConfig({ ...ENV, EMAIL_MODE: "smtp" }).mode).toBe("smtp");
    expect(loadOperatorEmail(ENV)).toBe("operator@example.invalid");
    expect(loadPublicBaseUrl(ENV)).toBe("https://radar.example.invalid");
    expect(loadWebConfig(ENV)).toMatchObject({ host: "127.0.0.1", port: 3000 });
    expect(loadContactEmail(ENV)).toBe("kontakt@example.invalid");
    // HEARTBEAT_URL ships empty (no heartbeat until DEPLOY.md point 10).
    expect(loadStatusConfig(ENV)).toEqual({ backupDir: "/var/backups/radar", heartbeatUrl: null });
    expect(
      loadStatusConfig({ ...ENV, HEARTBEAT_URL: "https://hc-ping.example.invalid/CHANGE_ME" }),
    ).toEqual({
      backupDir: "/var/backups/radar",
      heartbeatUrl: "https://hc-ping.example.invalid/CHANGE_ME",
    });
  });

  it("holds placeholders only", () => {
    for (const [key, value] of Object.entries(ENV)) {
      const host = URL.parse(value)?.hostname ?? "";
      if (host !== "" && host !== "localhost" && host !== "127.0.0.1") {
        expect(host, key).toMatch(/\.invalid$/);
      }
      if (value.includes("@") && !value.includes("://")) {
        expect(value, key).toMatch(/@example\.invalid>?$/);
      }
    }
    expect(ENV.DATABASE_URL).toContain(":CHANGE_ME@");
    expect(ENV.SMTP_URL).toContain(":CHANGE_ME@");
  });
});

describe("deploy/systemd/radar-serve.service", () => {
  it("runs serve as radar from the install directory with the env file", () => {
    expect(unitValue("User")).toBe("radar");
    expect(unitValue("WorkingDirectory")).toBe("/opt/radar-zamowien");
    expect(unitValue("ExecStart")).toBe(
      "/usr/bin/node --env-file=/etc/radar/radar.env dist/main.js serve",
    );
    expect(unitValue("Restart")).toBe("on-failure");
  });

  // PR-10 (D-031): serve sends the access e-mails — into the outbox in
  // EMAIL_MODE=test, its only writable path, or to the SMTP server.
  it("is hardened, writing only to the outbox and without MemoryDenyWriteExecute (V8's JIT)", () => {
    expect(unitValue("NoNewPrivileges")).toBe("yes");
    expect(unitValue("ProtectSystem")).toBe("strict");
    expect(unitValue("CapabilityBoundingSet")).toBe("");
    expect(unitEntries(UNIT).filter(([name]) => name === "ReadWritePaths")).toEqual([
      ["ReadWritePaths", `-${String(ENV.EMAIL_OUTBOX_DIR)}`],
    ]);
    expect(unitValue("MemoryDenyWriteExecute")).toBeUndefined();
    expect(unitValue("EnvironmentFile")).toBeUndefined();
  });

  it("reaches the loopback only: EMAIL_MODE=test, the default, needs no egress", () => {
    expect(ENV.EMAIL_MODE).toBe("test");
    expect(unitEntries(UNIT).filter(([name]) => name.startsWith("IPAddress"))).toEqual([
      ["IPAddressDeny", "any"],
      ["IPAddressAllow", "localhost"],
    ]);
  });

  // PR-10 (D-031): EMAIL_MODE=smtp sends the access e-mails to the provider.
  it("ships the smtp drop-in, which only resets the deny list", () => {
    const lines = SMTP_DROP_IN.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    expect(lines).toEqual(["[Service]", "IPAddressDeny="]);
    expect(SMTP_DROP_IN).toContain("/etc/systemd/system/radar-serve.service.d/");
    expect(SMTP_DROP_IN).toContain("systemctl daemon-reload && systemctl restart radar-serve");
  });
});

describe("deploy/cron/radar", () => {
  const unitDir = unitValue("WorkingDirectory") ?? "";
  const unitNode = (unitValue("ExecStart") ?? "").replace(/ serve$/, "");

  it("runs the commands in the runbook's order and times, as radar", () => {
    const jobs = cronJobs();
    expect(jobs.map((job) => `${job.hour}:${job.minute.padStart(2, "0")}`)).toEqual([
      "5:30",
      "5:45",
      "6:00",
      "6:30",
      "7:30",
      "7:45",
    ]);
    expect(new Set(jobs.map((job) => job.user))).toEqual(new Set(["radar"]));
  });

  it("starts every command exactly like the systemd unit, logging under /var/log/radar", () => {
    const commands = cronJobs()
      .map((job) => job.command)
      .filter((command) => command.includes("dist/main.js"))
      .map((command) => {
        const match =
          /^cd (\S+) && (.+ dist\/main\.js) (.+) >>(\/var\/log\/radar\/[a-z]+\.log) 2>&1$/.exec(
            command,
          );
        if (match === null) throw new Error(`unexpected command: ${command}`);
        const [, dir, node, args, log] = match;
        expect(dir).toBe(unitDir);
        expect(node).toBe(unitNode);
        return `${String(args)} >> ${String(log)}`;
      });
    expect(commands).toEqual([
      `backup ${String(ENV.BACKUP_DIR)} >> /var/log/radar/backup.log`,
      "ingest >> /var/log/radar/ingest.log",
      "status --notify >> /var/log/radar/status.log",
      "digest >> /var/log/radar/digest.log",
      "status --notify >> /var/log/radar/status.log",
    ]);
    // The logs are the ones logrotate rotates.
    expect(LOGROTATE).toMatch(/^\/var\/log\/radar\/\*\.log \{$/m);
  });

  it("keeps the 14 newest backups of BACKUP_DIR, by name", () => {
    const retention = cronJobs().find((job) => job.command.startsWith("find "));
    expect(retention?.command).toBe(
      `find ${String(ENV.BACKUP_DIR)} -maxdepth 1 -type f -name 'radar-[0-9]*T[0-9]*Z.dump' | sort | head -n -14 | xargs -r rm -f --`,
    );
  });

  it("has no CRON_TZ (unsupported by Debian's cron) and no % (cron's newline)", () => {
    expect(CRON).not.toMatch(/^CRON_TZ=/m);
    expect(CRON).not.toContain("%");
    expect(CRON.endsWith("\n")).toBe(true);
  });
});

describe("deploy/caddy/Caddyfile", () => {
  it("serves PUBLIC_BASE_URL's host and proxies to WEB_HOST:WEB_PORT", () => {
    const host = new URL(String(ENV.PUBLIC_BASE_URL)).host;
    expect(CADDYFILE).toMatch(new RegExp(`^${host.replaceAll(".", "\\.")} \\{$`, "m"));
    expect(CADDYFILE).toMatch(
      new RegExp(`^\\treverse_proxy ${String(ENV.WEB_HOST)}:${String(ENV.WEB_PORT)}$`, "m"),
    );
  });

  it("keeps the token paths out of the access log, adds no HSTS, and allows the profile form", () => {
    expect(CADDYFILE).toMatch(
      /^\t@token path \/dostep\/\* \/wypis\/\* \/potwierdz-email\/\* \/ocena\/\*$/m,
    );
    expect(CADDYFILE).toMatch(/^\tlog_skip @token$/m);
    expect(CADDYFILE.toLowerCase()).not.toMatch(/^[^#]*strict-transport-security/m);
    const maxSize = /^\t\tmax_size (\d+)KB$/m.exec(CADDYFILE)?.[1];
    expect(Number(maxSize) * 1000).toBeGreaterThan(PROFILE_FORM_MAX_BYTES);
  });

  // log_skip only drops access-log entries; the error log (journald) and the
  // access log both rewrite token paths in the URI and the Referer.
  const filterBlock = (logOpening: RegExp): string => {
    const start = logOpening.exec(CADDYFILE);
    if (start === null) throw new Error(`no log block ${String(logOpening)}`);
    const rest = CADDYFILE.slice(start.index);
    const filter = /\n(\t+)format filter \{\n([\s\S]*?)\n\1\}\n/.exec(rest);
    if (filter === null) throw new Error("no format filter");
    // The filter belongs to this log block: nothing but its output comes before it.
    expect(rest.slice(0, filter.index)).not.toMatch(/\n\t?\}\n/);
    return filter[2] ?? "";
  };
  // Plain quotes: Go's `${1}` must not become a template interpolation.
  const REDACT = '"(?i)/(dostep|wypis|potwierdz-email|ocena)/[^?#]*" "/${1}/REDACTED"';

  for (const [name, opening] of [
    ["the default logger (errors, redirects)", /^\tlog default \{$/m],
    ["the site's access log", /^\tlog \{$/m],
  ] as const) {
    it(`redacts token paths in ${name}`, () => {
      const lines = filterBlock(opening)
        .split("\n")
        .map((line) => line.trim());
      expect(lines).toEqual([
        `request>uri regexp ${REDACT}`,
        `request>headers>Referer regexp ${REDACT}`,
        "wrap json",
      ]);
    });
  }

  it("uses a pattern that removes the token and keeps the rest", () => {
    // The same rewrite in JS: (?i) → flag i, Go's ${1} → $1.
    const redact = (value: string) =>
      value.replace(/\/(dostep|wypis|potwierdz-email|ocena)\/[^?#]*/giu, "/$1/REDACTED");
    const token = "Kq3-not-a-real-token_x";
    expect(redact(`/dostep/${token}`)).toBe("/dostep/REDACTED");
    expect(redact(`/wypis/${token}?x=1`)).toBe("/wypis/REDACTED?x=1");
    expect(redact(`/potwierdz-email/${token}`)).toBe("/potwierdz-email/REDACTED");
    // A rating link (PR-12): the token and everything after it (offer id, verdict).
    expect(redact(`/ocena/${token}/0a6b5c4d-1e2f-4a3b-8c7d-6e5f4a3b2c1d/nietrafne`)).toBe(
      "/ocena/REDACTED",
    );
    // POST /dopasowania/ocena carries no token and is logged as is.
    expect(redact("/dopasowania/ocena")).toBe("/dopasowania/ocena");
    expect(redact(`/DOSTEP/${token}`)).toBe("/DOSTEP/REDACTED");
    expect(redact(`https://radar.example.invalid/dostep/${token}`)).toBe(
      "https://radar.example.invalid/dostep/REDACTED",
    );
    expect(redact("/profil")).toBe("/profil");
    // /zdrowie is logged as is (DEPLOY §10): neither redacted nor matched by @token.
    expect(redact("/zdrowie")).toBe("/zdrowie");
  });
});

describe("docs", () => {
  it("point to the artifacts and no longer use CRON_TZ", () => {
    const runbook = read("docs/RUNBOOK.md");
    const deploy = read("docs/DEPLOY.md");
    for (const path of [
      "deploy/cron/radar",
      "deploy/systemd/radar-serve.service",
      "deploy/systemd/radar-serve.service.d/smtp.conf",
      "deploy/caddy/Caddyfile",
      "deploy/logrotate/radar",
      "deploy/radar.env.example",
      "deploy/smoke.sh",
    ]) {
      expect(deploy).toContain(path);
    }
    expect(runbook).toContain("deploy/cron/radar");
    expect(runbook).not.toContain("CRON_TZ=");
  });
});

describe("deploy/smoke.sh", () => {
  const SCRIPT = join(process.cwd(), "deploy/smoke.sh");
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "radar-smoke-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is valid POSIX sh", () => {
    execFileSync("sh", ["-n", SCRIPT]);
    const dash = spawnSync("dash", ["-n", SCRIPT]);
    if (dash.error === undefined) expect(dash.status).toBe(0);
  });

  /**
   * Runs the script with stub commands first on PATH: `id` says root,
   * `runuser` runs its command, `node`, `systemctl` and `curl` answer as the
   * FAKE_* variables say. The env file holds a fake secret that must never be
   * printed.
   */
  function smoke(fake: Record<string, string>, args: string[] = []) {
    const bin = join(dir, "bin");
    const stubs: Record<string, string> = {
      id: 'echo "${FAKE_UID:-0}"',
      runuser: '[ "$1" = -u ] && [ "$2" = radar ] && [ "$3" = -- ] || exit 97\nshift 3\nexec "$@"',
      node: 'echo "secret: $FAKE_SECRET"\ncase "$3" in health) exit "${FAKE_HEALTH:-0}" ;; status) exit "${FAKE_STATUS:-0}" ;; esac\nexit 98',
      systemctl: 'exit "${FAKE_ACTIVE:-0}"',
      curl: [
        "for arg; do url=$arg; done",
        "case $url in",
        'https://*/zdrowie) [ "${FAKE_ZDROWIE:-200}" = 200 ] || exit 22; printf "ok\\n" ;;',
        'https://*) printf "HTTP/2 %s\\r\\n" "${FAKE_CODE:-200}"; [ "${FAKE_HSTS:-1}" -ge 1 ] && printf "strict-transport-security: max-age=31536000\\r\\n"; [ "${FAKE_HSTS:-1}" -ge 2 ] && printf "Strict-Transport-Security: max-age=1\\r\\n"; printf "\\r\\n" ;;',
        'http://*) printf "%s" "${FAKE_REDIRECT:-308 https://radar.example.invalid/}" ;;',
        "esac",
      ].join("\n"),
    };
    execFileSync("mkdir", ["-p", bin]);
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const envFile = join(dir, "radar.env");
    writeFileSync(
      envFile,
      "DATABASE_URL=postgres://radar:Zx9-smoke-secret@localhost:5432/radar\nPUBLIC_BASE_URL=https://radar.example.invalid\n",
    );
    const result = spawnSync("sh", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RADAR_DIR: dir,
        RADAR_ENV_FILE: envFile,
        NODE: join(bin, "node"),
        FAKE_SECRET: "Zx9-smoke-secret",
        ...fake,
      },
    });
    expect(result.stdout + result.stderr).not.toContain("Zx9-smoke-secret");
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("passes when every check passes, printing PASS lines only", () => {
    const result = smoke({});
    expect(result).toEqual({
      code: 0,
      stdout: [
        "PASS health (as radar)",
        "PASS status (as radar)",
        "PASS radar-serve is active",
        "PASS front page 200",
        "PASS one HSTS header",
        "PASS /zdrowie ok",
        "PASS http redirects to https",
        "Smoke test passed",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it.each([
    [{ FAKE_HEALTH: "1" }, "FAIL health (as radar)"],
    [{ FAKE_STATUS: "1" }, "FAIL status (as radar)"],
    [{ FAKE_ACTIVE: "3" }, "FAIL radar-serve is active"],
    [{ FAKE_CODE: "502" }, "FAIL front page 200"],
    [{ FAKE_HSTS: "0" }, "FAIL one HSTS header"],
    [{ FAKE_HSTS: "2" }, "FAIL one HSTS header"],
    [{ FAKE_ZDROWIE: "503" }, "FAIL /zdrowie ok"],
    [{ FAKE_REDIRECT: "200 " }, "FAIL http redirects to https"],
    [{ FAKE_REDIRECT: "308 https://elsewhere.example.invalid/" }, "FAIL http redirects to https"],
  ])("fails on %j and still runs the other checks", (fake, line) => {
    const result = smoke(fake);
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n")).toContain(line);
    expect(result.stdout.split("\n").filter((l) => l.startsWith("PASS"))).toHaveLength(6);
    expect(result.stdout.endsWith("Smoke test FAILED\n")).toBe(true);
  });

  it("takes the origin from its argument, and refuses one that is not an https origin", () => {
    expect(smoke({}, ["https://radar.example.invalid"]).code).toBe(0);
    for (const origin of [
      "http://radar.example.invalid",
      "https://radar.example.invalid/x",
      "https://a b",
    ]) {
      expect(smoke({}, [origin])).toMatchObject({
        code: 1,
        stdout: "FAIL origin must be https://<host> without a path\n",
      });
    }
  });

  it("refuses to run as another user than root", () => {
    expect(smoke({ FAKE_UID: "1000" })).toMatchObject({
      code: 1,
      stdout: "FAIL must run as root (it runs the commands as radar)\n",
    });
  });
});

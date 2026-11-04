import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { link, open, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Kysely } from "kysely";
import { pendingMigrations } from "../infrastructure/db/database.js";
import {
  countTableRows,
  currentSchemaName,
  listSchemaTables,
  schemaHasRelations,
} from "../infrastructure/db/maintenance-repository.js";
import type { Database } from "../infrastructure/db/schema.js";

/**
 * `backup` and `restore` (PR-07A, D-028): pg_dump/pg_restore (PostgreSQL 16
 * client or newer) of the application's schema — the connection's current
 * schema, which holds every table and the migration ledger.
 *
 * The tools run as child processes without a shell, with an argument array,
 * a fresh environment and a hard time limit. The database password never
 * appears in an argument, an output or a log: the connection goes in
 * `--dbname` as a libpq conninfo without it, the password in the child's
 * PGPASSWORD only. The tools' stderr is never echoed (it may name hosts,
 * users or objects): it is mapped to a fixed reason plus the exit status.
 */

/** Upper bound of one pg_dump/pg_restore run; then SIGTERM, then SIGKILL. */
export const PG_TOOL_TIMEOUT_MS = 30 * 60_000;
/** Between SIGTERM and SIGKILL when the time limit is hit. */
export const PG_TOOL_KILL_GRACE_MS = 5_000;
/** libpq's connect timeout of the tools (PGCONNECT_TIMEOUT), seconds. */
export const PG_TOOL_CONNECT_TIMEOUT_SECONDS = 10;
/** The tools' stderr kept for classification; the rest is discarded. */
const STDERR_LIMIT_BYTES = 64 * 1024;

export type BackupFailureReason =
  /** DATABASE_URL carries something the tools cannot be given exactly as `pg` uses it. */
  | "unsupported_database_url"
  /** search_path names no schema, or one the tools cannot be pointed at safely. */
  | "invalid_schema"
  /** The schema holds no table: there is nothing to back up. */
  | "nothing_to_back_up"
  /** `restore` only into a schema without tables. */
  | "target_not_empty"
  | "not_a_directory"
  | "not_a_file"
  /** A backup of the same second already exists. */
  | "file_exists"
  | "write_failed"
  /** pg_dump/pg_restore is not on PATH. */
  | "tool_not_found"
  /** The tools are older than the server or than the dump file. */
  | "version_mismatch"
  | "authentication_failed"
  | "unreachable"
  | "timeout"
  /** Any other failure of the tool: see the exit status. */
  | "tool_failed"
  /** pg_restore ended well but the schema still has no table (a dump of another schema). */
  | "nothing_restored";

export class BackupError extends Error {
  override readonly name = "BackupError";

  constructor(
    readonly reason: BackupFailureReason,
    /** A fixed detail: `exit N`, `signal NAME` or an option name; never tool output. */
    readonly detail: string | null = null,
  ) {
    super(detail === null ? reason : `${reason} (${detail})`);
  }
}

/** How the tools reach the database: a conninfo without the password, and the password. */
export interface PgToolConnection {
  readonly conninfo: string;
  readonly password: string | null;
}

/** Query parameters of DATABASE_URL that can be given to libpq with `pg`'s meaning. */
const URL_KEYS: ReadonlySet<string> = new Set([
  "host",
  "port",
  "user",
  "password",
  "options",
  "application_name",
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
]);

/** A conninfo value: single-quoted, `\` and `'` escaped (libpq's rules). */
function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function unsupported(key: string | null = null): BackupError {
  return new BackupError(
    "unsupported_database_url",
    key !== null && /^[a-z_]{1,32}$/.test(key) ? key : null,
  );
}

/**
 * libpq's sslmode for `pg`'s TLS settings (pg-connection-string without
 * uselibpqcompat): `pg` verifies the certificate and host name for prefer,
 * require, verify-ca and verify-full alike, against the system CAs unless
 * sslrootcert names a file; `no-verify` encrypts without verifying; no TLS
 * setting at all means no TLS.
 */
function tlsSettings(params: ReadonlyMap<string, string>): [string, string][] {
  const mode = params.get("sslmode");
  const ssl = params.get("ssl");
  const files = (["sslcert", "sslkey", "sslrootcert"] as const).filter((key) => params.has(key));
  let tls: "off" | "verify" | "encrypt";
  if (mode !== undefined) {
    if (mode === "disable") tls = "off";
    else if (mode === "no-verify") tls = "encrypt";
    else if (["prefer", "require", "verify-ca", "verify-full"].includes(mode)) tls = "verify";
    else throw unsupported("sslmode");
  } else if (files.length > 0) {
    tls = "verify";
  } else if (ssl === undefined || ssl === "0") {
    tls = "off";
  } else if (ssl === "true" || ssl === "1") {
    tls = "verify";
  } else {
    throw unsupported("ssl");
  }
  if (tls === "off") return [["sslmode", "disable"]];
  const certificates = files.map((key): [string, string] => [key, params.get(key) ?? ""]);
  if (tls === "encrypt") return [["sslmode", "require"], ...certificates];
  return [
    ["sslmode", "verify-full"],
    ...certificates,
    // libpq >= 16: verify against the system's CAs, as Node does by default.
    ...(params.has("sslrootcert") ? [] : [["sslrootcert", "system"] as [string, string]]),
  ];
}

/**
 * The connection of DATABASE_URL as the tools must get it, parsed the way
 * `pg` parses it (query parameters win over the URL's parts; defaults
 * localhost:5432). Anything that cannot be mapped exactly is refused
 * (`unsupported_database_url`, naming only the parameter). The PG* variables
 * `pg` would also read are refused separately (`assertNoPgConnectionEnv`).
 */
export function pgToolConnection(databaseUrl: string): PgToolConnection {
  const url = URL.parse(databaseUrl);
  if (url === null || (url.protocol !== "postgres:" && url.protocol !== "postgresql:")) {
    throw unsupported();
  }
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!URL_KEYS.has(key)) throw unsupported(key);
    params.set(key, value);
  }
  let user: string;
  let password: string;
  let host: string;
  let database: string;
  try {
    user = params.get("user") || decodeURIComponent(url.username);
    password = params.get("password") || decodeURIComponent(url.password);
    host = params.get("host") || decodeURIComponent(url.hostname.replace(/^\[(.+)\]$/, "$1")) || "";
    database = decodeURI(url.pathname.slice(1));
  } catch {
    throw unsupported();
  }
  const port = params.get("port") || url.port || "5432";
  if (!/^[1-9]\d{0,4}$/.test(port)) throw unsupported("port");
  const options = params.get("options");
  const entries: [string, string][] = [
    ["host", host === "" ? "localhost" : host],
    ["port", port],
    ...(database === "" ? [] : [["dbname", database] as [string, string]]),
    ...(user === "" ? [] : [["user", user] as [string, string]]),
    ...(options === undefined || options === "" ? [] : [["options", options] as [string, string]]),
    ...tlsSettings(params),
  ];
  // A control character cannot be meant and would not survive libpq's parser.
  if (entries.some(([, value]) => /\p{Cc}/u.test(value))) throw unsupported();
  return {
    conninfo: entries.map(([key, value]) => `${key}=${quote(value)}`).join(" "),
    password: password === "" ? null : password,
  };
}

/**
 * The environment variables `pg` falls back to for whatever DATABASE_URL
 * leaves out (host, port, user, password, database, options; TLS when the URL
 * has no ssl setting). The tools get a fresh environment without them, so
 * with any of them set the application and the tools could reach different
 * servers or use different TLS: all connection settings must be in
 * DATABASE_URL.
 */
export const PG_CONNECTION_ENV_VARS = [
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
] as const;

/**
 * Refuses (`unsupported_database_url`, naming only the variable, never its
 * value) when `env` sets any of PG_CONNECTION_ENV_VARS to a non-empty value.
 */
export function assertNoPgConnectionEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of PG_CONNECTION_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      throw new BackupError("unsupported_database_url", name);
    }
  }
}

/** A schema name the tools can be pointed at verbatim (`--schema` is a pattern). */
export function isPlainSchemaName(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

/** The child's whole environment: nothing else from ours (no PG* variables, no secrets). */
export function pgToolEnv(
  env: Readonly<Record<string, string | undefined>>,
  password: string | null,
): Record<string, string> {
  return {
    ...(env.PATH === undefined ? {} : { PATH: env.PATH }),
    ...(env.HOME === undefined ? {} : { HOME: env.HOME }),
    ...(password === null ? {} : { PGPASSWORD: password }),
    PGCONNECT_TIMEOUT: String(PG_TOOL_CONNECT_TIMEOUT_SECONDS),
    PGAPPNAME: "radar-zamowien",
    // English messages, so the classification below can read them.
    LC_ALL: "C",
  };
}

/** A fixed reason for the tool's stderr (never shown). */
export function classifyToolFailure(stderr: string): BackupFailureReason {
  if (/server version mismatch|unsupported version .* in file header/i.test(stderr)) {
    return "version_mismatch";
  }
  if (/password authentication failed|no password supplied|authentication failed/i.test(stderr)) {
    return "authentication_failed";
  }
  if (
    /could not connect|connection refused|could not translate host name|timeout expired|no route to host|network is unreachable/i.test(
      stderr,
    )
  ) {
    return "unreachable";
  }
  return "tool_failed";
}

export interface ToolRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** File descriptors for the child's stdin and stdout; "ignore" for none. */
  readonly stdin: number | "ignore";
  readonly stdout: number | "ignore";
  readonly timeoutMs: number;
  readonly killGraceMs: number;
}

/**
 * Runs the tool to its end; rejects with BackupError (`tool_not_found`,
 * `timeout`, or the classified stderr with the exit status). No shell: the
 * arguments are passed as they are.
 */
export function runTool(run: ToolRun): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(run.command, [...run.args], {
      env: run.env,
      shell: false,
      stdio: [run.stdin, run.stdout, "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let kept = 0;
    // Piped (stdio[2]), so present; `?.` only for the type.
    child.stderr?.on("data", (chunk: Buffer) => {
      if (kept >= STDERR_LIMIT_BYTES) return;
      const part = chunk.subarray(0, STDERR_LIMIT_BYTES - kept);
      chunks.push(part);
      kept += part.length;
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), run.killGraceMs);
    }, run.timeoutMs);
    const settle = (error: BackupError | null): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (error === null) resolvePromise();
      else reject(error);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(new BackupError(error.code === "ENOENT" ? "tool_not_found" : "tool_failed"));
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        settle(new BackupError("timeout"));
      } else if (code === 0) {
        settle(null);
      } else {
        const detail = code === null ? `signal ${signal ?? "unknown"}` : `exit ${String(code)}`;
        const stderr = Buffer.concat(chunks).toString("utf8");
        settle(new BackupError(classifyToolFailure(stderr), detail));
      }
    });
  });
}

/** `radar-YYYYMMDDTHHMMSSZ.dump` (UTC). */
export function backupFileName(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `radar-${stamp}.dump`;
}

const BACKUP_FILE_NAME = /^radar-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

/**
 * The time in a name written by backupFileName, or null for any other name
 * (temporary `.partial` files, copies, impossible dates such as month 13: the
 * name must be exactly what backupFileName gives for that time).
 */
export function parseBackupFileName(name: string): Date | null {
  const match = BACKUP_FILE_NAME.exec(name);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const at = new Date(
    Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0),
  );
  return backupFileName(at) === name ? at : null;
}

/** Names this far ahead of the clock are ignored: they would hide a stale backup. */
export const BACKUP_FUTURE_TOLERANCE_MS = 5 * 60_000;

export interface BackupDirectoryState {
  /** The backup files found (regular files named by backupFileName); null when unreadable. */
  readonly files: number | null;
  /** The time in the newest name; null when there is none or the directory is unreadable. */
  readonly newestAt: Date | null;
  /** The errno code (ENOENT, EACCES, ENOTDIR, …) when the directory could not be read. */
  readonly unreadableCode: string | null;
}

/**
 * What `status` checks of BACKUP_DIR (PR-07B, D-029): one readdir and a name
 * filter — no stat or open of the files. The time comes from the name, not
 * the mtime: a copy or a restore of the directory resets mtimes, and the name
 * is when the dump started. Never throws.
 */
export async function readBackupDirectory(
  directory: string,
  now: Date,
): Promise<BackupDirectoryState> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      files: null,
      newestAt: null,
      unreadableCode: typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : "unknown",
    };
  }
  let files = 0;
  let newestAt: Date | null = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const at = parseBackupFileName(entry.name);
    if (at === null || at.getTime() > now.getTime() + BACKUP_FUTURE_TOLERANCE_MS) continue;
    files += 1;
    if (newestAt === null || at > newestAt) newestAt = at;
  }
  return { files, newestAt, unreadableCode: null };
}

export interface ToolOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

/**
 * Dumps `schema` (custom format, no owners or privileges) into a new file in
 * `dir`, readable by the owner only: written under a temporary name, synced,
 * then linked to its final name (never replacing a file) — on any failure
 * nothing is left behind. Returns the file's path and size.
 */
export async function dumpSchema(
  databaseUrl: string,
  schema: string,
  dir: string,
  now: Date,
  options: ToolOptions,
): Promise<{ readonly file: string; readonly bytes: number }> {
  if (!isPlainSchemaName(schema)) throw new BackupError("invalid_schema");
  const connection = pgToolConnection(databaseUrl);
  assertNoPgConnectionEnv(options.env);
  const directory = resolve(dir);
  const isDirectory = await stat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isDirectory) throw new BackupError("not_a_directory");
  const file = join(directory, backupFileName(now));
  const temporary = join(directory, `.${backupFileName(now)}.${randomUUID()}.partial`);
  const handle = await open(temporary, "wx", 0o600).catch(() => {
    throw new BackupError("write_failed");
  });
  let linked = false;
  try {
    try {
      await runTool({
        command: "pg_dump",
        args: [
          "--format=custom",
          "--no-owner",
          "--no-acl",
          `--schema=${schema}`,
          `--dbname=${connection.conninfo}`,
        ],
        env: pgToolEnv(options.env, connection.password),
        stdin: "ignore",
        stdout: handle.fd,
        timeoutMs: options.timeoutMs ?? PG_TOOL_TIMEOUT_MS,
        killGraceMs: options.killGraceMs ?? PG_TOOL_KILL_GRACE_MS,
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, file).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      throw new BackupError(code === "EEXIST" ? "file_exists" : "write_failed");
    });
    linked = true;
    const { size } = await stat(file);
    return { file, bytes: size };
  } catch (error: unknown) {
    if (linked) await rm(file, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Restores `schema` from a pg_dump custom-format file, in one transaction
 * (all or nothing), without owners or privileges. The caller has checked
 * that the schema exists and has no tables.
 */
export async function restoreSchema(
  databaseUrl: string,
  schema: string,
  path: string,
  options: ToolOptions,
): Promise<void> {
  if (!isPlainSchemaName(schema)) throw new BackupError("invalid_schema");
  const connection = pgToolConnection(databaseUrl);
  assertNoPgConnectionEnv(options.env);
  // Absolute, so the file name can never be read as an option.
  const file = resolve(path);
  const isFile = await stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
  if (!isFile) throw new BackupError("not_a_file");
  await runTool({
    command: "pg_restore",
    args: [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--single-transaction",
      `--schema=${schema}`,
      `--dbname=${connection.conninfo}`,
      file,
    ],
    env: pgToolEnv(options.env, connection.password),
    stdin: "ignore",
    stdout: "ignore",
    timeoutMs: options.timeoutMs ?? PG_TOOL_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? PG_TOOL_KILL_GRACE_MS,
  });
}

export interface BackupResult {
  readonly file: string;
  readonly bytes: number;
  readonly schema: string;
  readonly tables: number;
}

/** `backup <dir>`: the application's schema into a new dump file in `dir`. */
export async function backupDatabase(
  db: Kysely<Database>,
  databaseUrl: string,
  dir: string,
  now: Date,
  options: ToolOptions,
): Promise<BackupResult> {
  // Checked before the database is read: a bad URL is a configuration problem.
  pgToolConnection(databaseUrl);
  assertNoPgConnectionEnv(options.env);
  const schema = await currentSchemaName(db);
  if (schema === null || !isPlainSchemaName(schema)) throw new BackupError("invalid_schema");
  const tables = await listSchemaTables(db, schema);
  if (tables.length === 0) throw new BackupError("nothing_to_back_up");
  const { file, bytes } = await dumpSchema(databaseUrl, schema, dir, now, options);
  return { file, bytes, schema, tables: tables.length };
}

export interface RestoreResult {
  readonly schema: string;
  /** Exact row counts per restored table. */
  readonly tables: Record<string, number>;
  /** Migrations the restored schema still lacks (a dump of an older version). */
  readonly pendingMigrations: string[];
}

/**
 * `restore <file>`: into the connection's current schema, only when it exists
 * and holds no relation at all — never over data. Then the schema readiness
 * check of `health` and the row counts per table.
 */
export async function restoreDatabase(
  db: Kysely<Database>,
  databaseUrl: string,
  file: string,
  options: ToolOptions,
): Promise<RestoreResult> {
  pgToolConnection(databaseUrl);
  assertNoPgConnectionEnv(options.env);
  const schema = await currentSchemaName(db);
  if (schema === null || !isPlainSchemaName(schema)) throw new BackupError("invalid_schema");
  if (await schemaHasRelations(db, schema)) throw new BackupError("target_not_empty");
  await restoreSchema(databaseUrl, schema, file, options);
  const tables = await listSchemaTables(db, schema);
  if (tables.length === 0) throw new BackupError("nothing_restored");
  return {
    schema,
    tables: await countTableRows(db, schema, tables),
    pendingMigrations: await pendingMigrations(db),
  };
}

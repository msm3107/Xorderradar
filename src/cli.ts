import type { Kysely } from "kysely";
import { checkHealth } from "./health.js";
import { ConfigError, loadConfig, type AppConfig } from "./infrastructure/config.js";
import {
  createDatabase,
  MigrationError,
  migrateToLatest,
  pingDatabase,
} from "./infrastructure/db/database.js";
import { describeDatabaseFailure, formatDatabaseFailure } from "./infrastructure/db/errors.js";
import type { Database } from "./infrastructure/db/schema.js";
import { HttpClientError } from "./infrastructure/http/errors.js";
import {
  SafeHttpClient,
  type SafeHttpClientOptions,
} from "./infrastructure/http/safe-http-client.js";
import { createLogger, type Logger } from "./infrastructure/logger.js";
import { INGEST_LOCK_KEY, withIngestLock, type LockResult } from "./ingestion/lock.js";
import {
  IngestionRequestError,
  overallStatus,
  runIngestion,
  SchemaNotReadyError,
  type IngestionRequest,
  type IngestionRunResult,
} from "./ingestion/run.js";
import { previewSource, type SourcePreview } from "./sources/preview.js";
import { sourceAdapters } from "./sources/registry.js";
import { SourceFormatError, type SourceAdapter, type SourceHttpClient } from "./sources/types.js";

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The database operations commands need, opened per command and always closed. */
export interface CliDatabase {
  ping(): Promise<void>;
  /** Applies pending migrations; resolves with the names applied by this run. */
  migrate(): Promise<string[]>;
  close(): Promise<void>;
  /**
   * Runs `task` with the pool while holding the ingest advisory lock
   * (src/ingestion/lock.ts); `{ acquired: false }` when another run holds it.
   * `signal` is aborted when the lock is lost during the task.
   * Optional only so that stubs for the other commands need not provide it.
   */
  withIngestLock?<T>(
    task: (db: Kysely<Database>, signal: AbortSignal) => Promise<T>,
    logger: Logger,
  ): Promise<LockResult<T>>;
}

/** What commands that read sources need; injected so tests run without the network. */
export interface CliSourceDeps {
  readonly adapters: ReadonlyMap<string, SourceAdapter>;
  /** One client per source run (its error budget and rate limit are per instance). */
  readonly createHttpClient: (options: SafeHttpClientOptions) => SourceHttpClient;
  readonly now: () => Date;
  /** Run-level timeout of one source run (docs/SECURITY.md §4). */
  readonly runTimeoutMs: number;
  /** Timeout of one source within `ingest`; INGEST_SOURCE_TIMEOUT_MS when absent. */
  readonly ingestTimeoutMs?: number;
}

/** External dependencies, injected so the CLI can be unit-tested without PostgreSQL. */
export interface CliDeps {
  /** Must not connect yet; connecting happens on the first operation. */
  readonly openDatabase: (databaseUrl: string) => CliDatabase;
  /** Defaults to defaultSourceDeps (the real network); tests inject fakes. */
  readonly sources?: CliSourceDeps;
}

/**
 * Bounds a whole `source:preview` run. Its default limit needs one request per
 * notice type; the 500-record maximum (per notice type) about 40 requests at
 * >= 2 s each.
 */
export const SOURCE_RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Bounds one source within `ingest` (D-018). The default limit of 1000
 * records per notice type is at most 2 × 40 pages for BZP, i.e. 80 requests
 * spaced >= 2 s apart (>= 160 s) plus response and write time; 10 minutes
 * leaves about 7 s per request.
 */
export const INGEST_SOURCE_TIMEOUT_MS = 10 * 60_000;

/**
 * Production source wiring. SafeHttpClient is constructed with options only:
 * its test-only deps could bypass the SSRF protection and rate limiting (D-014).
 */
export const defaultSourceDeps: CliSourceDeps = {
  adapters: sourceAdapters,
  createHttpClient: (options) => new SafeHttpClient(options),
  now: () => new Date(),
  runTimeoutMs: SOURCE_RUN_TIMEOUT_MS,
  ingestTimeoutMs: INGEST_SOURCE_TIMEOUT_MS,
};

/**
 * A real connection pool (src/infrastructure/db). `lockHeartbeatMs` exists for
 * integration tests; production uses INGEST_LOCK_HEARTBEAT_MS.
 */
export function openCliDatabase(
  databaseUrl: string,
  options: { readonly lockHeartbeatMs?: number } = {},
): CliDatabase {
  const db = createDatabase(databaseUrl);
  return {
    ping: () => pingDatabase(db),
    migrate: () => migrateToLatest(db),
    close: () => db.destroy(),
    withIngestLock: (task, logger) =>
      withIngestLock(db, (signal) => task(db, signal), {
        logger,
        ...(options.lockHeartbeatMs === undefined ? {} : { heartbeatMs: options.lockHeartbeatMs }),
      }),
  };
}

/** Production wiring. */
export const defaultCliDeps: CliDeps = {
  sources: defaultSourceDeps,
  openDatabase: (databaseUrl) => openCliDatabase(databaseUrl),
};

/** Exit codes follow the usual convention: 0 ok, 1 runtime/config failure, 2 usage error. */
export const ExitCode = { Ok: 0, Failure: 1, Usage: 2 } as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export const PREVIEW_DEFAULT_LIMIT = 20;
export const PREVIEW_MAX_LIMIT = 500;
/** Records per notice type and source in `ingest`: the BZP page limit (40 × 25). */
export const INGEST_DEFAULT_LIMIT = 1000;
export const INGEST_MAX_LIMIT = 1000;

const usage = `Usage: radar-zamowien <command> [arguments]

Commands:
  health    Print a JSON health report (incl. database connectivity); exit 0 when operational.
  migrate   Apply pending database migrations; prints the applied names (none when up to date).
  source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]
            Fetch the notices a source published on one day and print them normalized as
            JSON; nothing is stored. Requires CRAWLER_CONTACT.
            Sources: ${[...sourceAdapters.keys()].join(", ")}.
            --date   publication day, default yesterday (UTC)
            --limit  max records per notice type, 1-${String(PREVIEW_MAX_LIMIT)}, default ${String(PREVIEW_DEFAULT_LIMIT)}
  ingest [sourceId...] [--date YYYY-MM-DD] [--limit N]
            Fetch and store the notices published on one day, with deduplication and change
            detection, from the given sources or all enabled ones; prints a JSON summary and
            records each source run. One run at a time (lock). Requires CRAWLER_CONTACT and
            an up-to-date schema (migrate). Exit 1 when any source failed.
            --date   publication day, default yesterday (UTC)
            --limit  max records per notice type, 1-${String(INGEST_MAX_LIMIT)}, default ${String(INGEST_DEFAULT_LIMIT)}
`;

type Command = "health" | "migrate" | "source:preview" | "ingest";
const commands: readonly Command[] = ["health", "migrate", "source:preview", "ingest"];

function isCommand(value: string): value is Command {
  return (commands as readonly string[]).includes(value);
}

interface PreviewArgs {
  readonly adapter: SourceAdapter;
  readonly publicationDate: string;
  readonly limit: number;
}

interface IngestArgs {
  /** Empty: every enabled source. */
  readonly sourceIds: readonly string[];
  readonly publicationDate: string;
  readonly limit: number;
}

type Invocation =
  | { readonly command: "health" | "migrate" }
  | { readonly command: "source:preview"; readonly preview: PreviewArgs }
  | { readonly command: "ingest"; readonly ingest: IngestArgs };

/** A real calendar day as `YYYY-MM-DD` (2026-02-30 is rejected, not rolled over). */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** The previous calendar day in UTC. */
function yesterdayUtc(now: Date): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** Returns the parsed arguments or a usage error message. */
function parsePreviewArgs(args: readonly string[], sources: CliSourceDeps): PreviewArgs | string {
  const [sourceId, ...options] = args;
  if (sourceId === undefined || sourceId.startsWith("-")) {
    return 'Command "source:preview" needs a source id.';
  }
  const adapter = sources.adapters.get(sourceId);
  if (adapter === undefined) return `Unknown source: ${JSON.stringify(sourceId)}`;
  let publicationDate: string | null = null;
  let limit: number | null = null;
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index] ?? "";
    const value = options[index + 1];
    if (name !== "--date" && name !== "--limit") {
      return `Unexpected argument: ${JSON.stringify(name)}`;
    }
    if (value === undefined) return `Option ${name} needs a value.`;
    if (name === "--date") {
      if (publicationDate !== null) return "Option --date given twice.";
      if (!isCalendarDate(value)) return "--date must be a calendar date YYYY-MM-DD.";
      publicationDate = value;
    } else {
      if (limit !== null) return "Option --limit given twice.";
      if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > PREVIEW_MAX_LIMIT) {
        return `--limit must be an integer from 1 to ${String(PREVIEW_MAX_LIMIT)}.`;
      }
      limit = Number(value);
    }
  }
  return {
    adapter,
    publicationDate: publicationDate ?? yesterdayUtc(sources.now()),
    limit: limit ?? PREVIEW_DEFAULT_LIMIT,
  };
}

/**
 * `ingest [sourceId...] [--date YYYY-MM-DD] [--limit N]`. Source ids must be
 * supported by this build (enabled in the database is checked later, before
 * any fetch). Returns the parsed arguments or a usage error message.
 */
function parseIngestArgs(args: readonly string[], sources: CliSourceDeps): IngestArgs | string {
  const sourceIds: string[] = [];
  let publicationDate: string | null = null;
  let limit: number | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) {
      if (!sources.adapters.has(arg)) return `Unknown source: ${JSON.stringify(arg)}`;
      if (sourceIds.includes(arg)) return `Source ${JSON.stringify(arg)} given twice.`;
      sourceIds.push(arg);
      continue;
    }
    if (arg !== "--date" && arg !== "--limit") return `Unexpected argument: ${JSON.stringify(arg)}`;
    const value = args[index + 1];
    if (value === undefined) return `Option ${arg} needs a value.`;
    index++;
    if (arg === "--date") {
      if (publicationDate !== null) return "Option --date given twice.";
      if (!isCalendarDate(value)) return "--date must be a calendar date YYYY-MM-DD.";
      publicationDate = value;
    } else {
      if (limit !== null) return "Option --limit given twice.";
      if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > INGEST_MAX_LIMIT) {
        return `--limit must be an integer from 1 to ${String(INGEST_MAX_LIMIT)}.`;
      }
      limit = Number(value);
    }
  }
  return {
    sourceIds,
    publicationDate: publicationDate ?? yesterdayUtc(sources.now()),
    limit: limit ?? INGEST_DEFAULT_LIMIT,
  };
}

/** Returns the invocation or a usage error message. */
function parseInvocation(
  command: Command,
  rest: readonly string[],
  sources: CliSourceDeps,
): Invocation | string {
  if (command === "source:preview") {
    const preview = parsePreviewArgs(rest, sources);
    return typeof preview === "string" ? preview : { command, preview };
  }
  if (command === "ingest") {
    const ingest = parseIngestArgs(rest, sources);
    return typeof ingest === "string" ? ingest : { command, ingest };
  }
  if (rest.length > 0) return `Command "${command}" takes no arguments.`;
  return { command };
}

const CRAWLER_CONTACT_REQUIRED =
  "CRAWLER_CONTACT is required for fetching sources (an e-mail address or https URL).\n";

/** Printed instead of an unexpected error, whose message or stack could carry configuration. */
export const INTERNAL_ERROR_MESSAGE = "Internal error: the command failed unexpectedly.\n";

/**
 * Single entry point for every operational command (later: digest).
 * Kept free of process globals so it can be tested directly.
 *
 * Order matters: the command and its arguments are validated first, so a usage
 * error always exits 2 even when the configuration is also invalid; only a valid
 * invocation loads the configuration (exit 1 on failure) and only then is the
 * database opened. The database is closed before returning, on every path.
 *
 * Never rejects: an unexpected error (a bug, a failing close) becomes exit 1
 * with a fixed message. Its message and stack are deliberately not printed —
 * they may contain the DATABASE_URL or other configuration values.
 */
export async function runCli(args: readonly string[], io: CliIo, deps: CliDeps): Promise<ExitCode> {
  try {
    return await runCommand(args, io, deps);
  } catch {
    io.stderr(INTERNAL_ERROR_MESSAGE);
    return ExitCode.Failure;
  }
}

async function runCommand(args: readonly string[], io: CliIo, deps: CliDeps): Promise<ExitCode> {
  const [command, ...rest] = args;

  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(usage);
    return command === undefined ? ExitCode.Usage : ExitCode.Ok;
  }

  if (!isCommand(command)) {
    io.stderr(`Unknown command: ${JSON.stringify(command)}\n\n${usage}`);
    return ExitCode.Usage;
  }
  const sources = deps.sources ?? defaultSourceDeps;
  const invocation = parseInvocation(command, rest, sources);
  if (typeof invocation === "string") {
    io.stderr(`${invocation}\n\n${usage}`);
    return ExitCode.Usage;
  }

  let config: AppConfig;
  try {
    config = loadConfig(io.env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return ExitCode.Failure;
    }
    throw error;
  }

  // Reads a source only: no database is opened (DATABASE_URL is still
  // validated by loadConfig, like for every command).
  if (invocation.command === "source:preview") {
    return runSourcePreview(config, invocation.preview, io, sources);
  }

  const database = deps.openDatabase(config.databaseUrl);
  try {
    switch (invocation.command) {
      case "health":
        return await runHealth(config, database, io);
      case "migrate":
        return await runMigrate(database, io);
      case "ingest":
        return await runIngest(config, invocation.ingest, database, io, sources);
    }
  } finally {
    await database.close();
  }
}

async function runHealth(config: AppConfig, database: CliDatabase, io: CliIo): Promise<ExitCode> {
  const report = await checkHealth(config, () => database.ping());
  io.stdout(`${JSON.stringify(report)}\n`);
  if (report.database.status === "error") {
    io.stderr(`Database check failed: ${formatDatabaseFailure(report.database)}\n`);
    return ExitCode.Failure;
  }
  return ExitCode.Ok;
}

/**
 * Error output names the failed migration (if any) and a fixed reason/code;
 * raw error messages are never printed (see describeDatabaseFailure).
 */
async function runMigrate(database: CliDatabase, io: CliIo): Promise<ExitCode> {
  try {
    const applied = await database.migrate();
    io.stdout(`${JSON.stringify({ status: "ok", applied })}\n`);
    return ExitCode.Ok;
  } catch (error: unknown) {
    const migration = error instanceof MigrationError ? error.failedMigration : null;
    const failure = describeDatabaseFailure(error instanceof MigrationError ? error.cause : error);
    const where = migration === null ? "" : ` in ${JSON.stringify(migration)}`;
    io.stderr(`Migration failed${where}: ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }
}

/** Groups rejections by their fixed reason text (field names only, no source values). */
function countReasons(preview: SourcePreview): Record<string, number> {
  const counts = new Map<string, number>();
  for (const { reason } of preview.rejections) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return Object.fromEntries(counts);
}

/**
 * `source:preview`: one bounded source run (record limit, page limits in the
 * adapter, run timeout) through a fresh SafeHttpClient, printed as JSON on
 * stdout. Nothing is stored. Log lines (JSON on stderr) carry the sourceId,
 * duration, status and counts — never URLs or response content.
 */
async function runSourcePreview(
  config: AppConfig,
  args: PreviewArgs,
  io: CliIo,
  sources: CliSourceDeps,
): Promise<ExitCode> {
  const { adapter } = args;
  // Checked here as well as in SafeHttpClient, so the rule does not depend on
  // which client factory is wired in.
  if (config.crawlerContact === null) {
    io.stderr(CRAWLER_CONTACT_REQUIRED);
    return ExitCode.Failure;
  }
  const logger = createLogger(config.logLevel, io.stderr);
  let http: SourceHttpClient;
  try {
    http = sources.createHttpClient({
      sourceId: adapter.sourceId,
      allowedHosts: adapter.allowedHosts,
      contact: config.crawlerContact,
      logger,
    });
  } catch (error: unknown) {
    // SafeHttpClient refuses to start without CRAWLER_CONTACT.
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return ExitCode.Failure;
    }
    throw error;
  }

  const signal = AbortSignal.timeout(sources.runTimeoutMs);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let preview: SourcePreview;
  try {
    preview = await previewSource(adapter, {
      http,
      signal,
      publicationDate: args.publicationDate,
      maxRecords: args.limit,
      now: sources.now,
      logger,
    });
  } catch (error: unknown) {
    if (!(error instanceof HttpClientError) && !(error instanceof SourceFormatError)) throw error;
    const timedOut = signal.aborted;
    logger.error("source preview failed", {
      sourceId: adapter.sourceId,
      status: "error",
      durationMs: elapsed(),
      errorCode: error instanceof HttpClientError ? error.code : "invalid_document",
      httpStatus: error instanceof HttpClientError ? error.status : null,
      timedOut,
    });
    const why = timedOut ? "run timeout exceeded" : error.message;
    io.stderr(`Source preview failed: ${why}\n`);
    return ExitCode.Failure;
  }

  const durationMs = elapsed();
  const counts = {
    documents: preview.documents,
    extracted: preview.extracted,
    normalized: preview.candidates.length,
    rejected: preview.rejections.length,
  };
  logger.info("source preview finished", {
    sourceId: adapter.sourceId,
    status: "ok",
    durationMs,
    ...counts,
    incomplete: preview.incomplete,
  });
  const report = {
    status: "ok",
    sourceId: adapter.sourceId,
    publicationDate: args.publicationDate,
    limit: args.limit,
    durationMs,
    ...counts,
    rejectionReasons: countReasons(preview),
    incomplete: preview.incomplete,
    rejections: preview.rejections,
    records: preview.candidates,
  };
  io.stdout(`${JSON.stringify(report)}\n`);
  return ExitCode.Ok;
}

/**
 * `ingest`: runs the sources under the ingest lock (one run at a time, D-019)
 * and prints a JSON summary on stdout. Each source's run is stored in
 * `ingestion_runs` and logged (sourceId, status, counters, duration) by
 * runIngestion. Exit 0 when every source succeeded or was incomplete; 1 when
 * any failed, a run could not be recorded, the lock is busy or was lost
 * during the run (the run is aborted, `lock_lost`), the schema is not
 * migrated or the database is unavailable; 2 for a source that is not
 * enabled in the database (a usage error found once the database is read).
 */
async function runIngest(
  config: AppConfig,
  args: IngestArgs,
  database: CliDatabase,
  io: CliIo,
  sources: CliSourceDeps,
): Promise<ExitCode> {
  const contact = config.crawlerContact;
  if (contact === null) {
    io.stderr(CRAWLER_CONTACT_REQUIRED);
    return ExitCode.Failure;
  }
  if (database.withIngestLock === undefined) throw new Error("database cannot run ingest");
  const logger = createLogger(config.logLevel, io.stderr);
  const request: IngestionRequest = {
    ...(args.sourceIds.length > 0 ? { sourceIds: args.sourceIds } : {}),
    publicationDate: args.publicationDate,
    maxRecords: args.limit,
  };

  let locked: LockResult<IngestionRunResult[]>;
  try {
    locked = await database.withIngestLock(
      (db, signal) =>
        runIngestion(
          {
            db,
            adapters: sources.adapters,
            createHttpClient: (adapter) =>
              sources.createHttpClient({
                sourceId: adapter.sourceId,
                allowedHosts: adapter.allowedHosts,
                contact,
                logger,
              }),
            now: sources.now,
            logger,
            sourceTimeoutMs: sources.ingestTimeoutMs ?? INGEST_SOURCE_TIMEOUT_MS,
            signal,
          },
          request,
        ),
      logger,
    );
  } catch (error: unknown) {
    if (error instanceof IngestionRequestError) {
      io.stderr(`${error.message}\n\n${usage}`);
      return ExitCode.Usage;
    }
    if (error instanceof SchemaNotReadyError) {
      io.stderr(`Ingest failed: ${error.message}\n`);
      return ExitCode.Failure;
    }
    // Connection/server failures get a fixed reason; anything else is a bug.
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Ingest failed: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }

  if (!locked.acquired) {
    logger.warn("ingest lock busy", { lockKey: String(INGEST_LOCK_KEY) });
    io.stderr("Another ingest run holds the lock; nothing was fetched.\n");
    return ExitCode.Failure;
  }
  const runs = locked.value;
  // Without the lock another run may have started: never report success.
  const status = locked.lockLost ? "failed" : overallStatus(runs);
  const report = {
    status,
    publicationDate: args.publicationDate,
    limit: args.limit,
    runs: runs.map((run) => ({
      sourceId: run.sourceId,
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.finishedAt.getTime() - run.startedAt.getTime(),
      ...run.counters,
      incomplete: run.incomplete,
      errorCode: run.errorCode,
    })),
  };
  io.stdout(`${JSON.stringify(report)}\n`);
  if (status !== "failed") return ExitCode.Ok;
  if (locked.lockLost) {
    io.stderr("Ingest aborted: the ingest lock was lost during the run (lock_lost).\n");
  }
  const failed = runs
    .filter((run) => run.status === "failed" || run.runId === null)
    .map((run) => `${run.sourceId} (${run.errorCode ?? "run_not_recorded"})`);
  if (failed.length > 0) io.stderr(`Ingest failed for: ${failed.join(", ")}\n`);
  return ExitCode.Failure;
}

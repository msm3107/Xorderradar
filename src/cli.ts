import type { Kysely } from "kysely";
import { entityIdSchema } from "./domain/common.js";
import type { CompanyProfile, CompanyProfileInput } from "./domain/company-profile.js";
import { DomainError } from "./domain/errors.js";
import type { NoticeUpdate } from "./domain/notice-update.js";
import { checkHealth } from "./health.js";
import { ConfigError, loadConfig, type AppConfig } from "./infrastructure/config.js";
import {
  createDatabase,
  MigrationError,
  migrateToLatest,
  pendingMigrations,
  pingDatabase,
} from "./infrastructure/db/database.js";
import { describeDatabaseFailure, formatDatabaseFailure } from "./infrastructure/db/errors.js";
import type { Database } from "./infrastructure/db/schema.js";
import { HttpClientError } from "./infrastructure/http/errors.js";
import {
  SafeHttpClient,
  type SafeHttpClientOptions,
} from "./infrastructure/http/safe-http-client.js";
import {
  createCompanyProfile,
  getCompanyProfile,
} from "./infrastructure/db/company-profiles-repository.js";
import {
  listMatchCandidates,
  type MatchCandidates,
} from "./infrastructure/db/opportunities-repository.js";
import { createLogger, type Logger } from "./infrastructure/logger.js";
import {
  daySpan,
  INGEST_MAX_CONSECUTIVE_FAILED_DAYS,
  INGEST_MAX_DAY,
  INGEST_MAX_DAYS,
  INGEST_MIN_DAY,
  isIngestDay,
  yesterdayUtc,
} from "./ingestion/catch-up.js";
import { INGEST_LOCK_KEY, withIngestLock, type LockResult } from "./ingestion/lock.js";
import {
  IngestionRequestError,
  overallStatus,
  runIngestion,
  SchemaNotReadyError,
  type IngestionOutcome,
  type IngestionRequest,
} from "./ingestion/run.js";
import {
  formatMatchPreview,
  MATCH_PREVIEW_DEFAULT_LIMIT,
  MATCH_PREVIEW_MAX_LIMIT,
  PROFILE_FILE_MAX_BYTES,
  readProfileFile,
  showProfile,
} from "./profile-commands.js";
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
  /**
   * Names of the migrations not applied yet (read-only; the readiness check
   * shared with `ingest`). Optional only so that stubs for the other commands
   * need not provide it.
   */
  pendingMigrations?(): Promise<string[]>;
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
  /**
   * Company profiles and match candidates (repositories in
   * src/infrastructure/db). Optional only so that stubs for the other
   * commands need not provide them.
   */
  createCompanyProfile?(input: CompanyProfileInput): Promise<CompanyProfile>;
  getCompanyProfile?(id: string): Promise<CompanyProfile | null>;
  /**
   * Offers not closed or cancelled, newest first, and the ids of invalid rows
   * left out (listMatchCandidates).
   */
  listMatchCandidates?(limit: number): Promise<MatchCandidates>;
}

/** What commands that read sources need; injected so tests run without the network. */
export interface CliSourceDeps {
  readonly adapters: ReadonlyMap<string, SourceAdapter>;
  /** One client per source run (its error budget and rate limit are per instance). */
  readonly createHttpClient: (options: SafeHttpClientOptions) => SourceHttpClient;
  readonly now: () => Date;
  /** Run-level timeout of one source run (docs/SECURITY.md §4). */
  readonly runTimeoutMs: number;
  /** Timeout of one source and day within `ingest`; INGEST_SOURCE_TIMEOUT_MS when absent. */
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
 * notice type (3 for BZP); the 500-record maximum (per notice type) up to
 * 3 × 20 requests at >= 2 s each (>= 120 s).
 */
export const SOURCE_RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Bounds one source and one publication day within `ingest` (D-018). The
 * default limit of 1000 records per notice type is at most 3 × 40 pages for
 * BZP (contract notices, small contracts, notice updates), i.e. 120 requests
 * spaced >= 2 s apart (>= 240 s) plus response and write time; 10 minutes
 * leaves about 5 s per request. A run covers up to INGEST_MAX_DAYS days, each
 * with its own timeout: the worst case is 31 × 10 min per source (D-021).
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
    pendingMigrations: () => pendingMigrations(db),
    close: () => db.destroy(),
    withIngestLock: (task, logger) =>
      withIngestLock(db, (signal) => task(db, signal), {
        logger,
        ...(options.lockHeartbeatMs === undefined ? {} : { heartbeatMs: options.lockHeartbeatMs }),
      }),
    createCompanyProfile: (input) => createCompanyProfile(db, input),
    getCompanyProfile: (id) => getCompanyProfile(db, id),
    listMatchCandidates: (limit) => listMatchCandidates(db, limit),
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
  health    Print a JSON health report (database connectivity, no pending migrations); exit 0
            when operational, 1 otherwise.
  migrate   Apply pending database migrations; prints the applied names (none when up to date).
  source:preview <sourceId> [--date YYYY-MM-DD] [--limit N]
            Fetch the notices a source published on one day and print them normalized as
            JSON, with the notice updates listed separately (new deadline or skip reason);
            nothing is stored. Requires CRAWLER_CONTACT.
            Sources: ${[...sourceAdapters.keys()].join(", ")}.
            --date   publication day, default yesterday (UTC)
            --limit  max records per notice type, 1-${String(PREVIEW_MAX_LIMIT)}, default ${String(PREVIEW_DEFAULT_LIMIT)}
  ingest [sourceId...] [--date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD] [--limit N]
            Fetch and store the notices published on the given days, with deduplication and
            change detection, and apply published notice updates (new offer deadlines), from
            the given sources or all enabled ones; prints a JSON summary and records each
            source's run per day. Without --date/--from/--to: catch-up, i.e. per source every
            day of the ${String(INGEST_MAX_DAYS)} days ending yesterday (UTC) that is not covered (a succeeded or
            incomplete run started after that day ended), from the source's earliest run on;
            yesterday only for a source that never ran. Missing days older than that are not
            run (reported as clipped, from-to). Days run in order; after ${String(INGEST_MAX_CONSECUTIVE_FAILED_DAYS)} consecutive failed
            first attempts (days with no earlier run of the source; a failed retry neither
            counts nor resets) a source's remaining days are not run (notRun,
            consecutive_failures). Each run lists skippedReasons. One run at a time (lock): while another run holds it,
            prints status "skipped" and exits 0 without fetching. Requires CRAWLER_CONTACT
            and an up-to-date schema (migrate). Exit 1 when any source failed.
            --date   one publication day (days from ${INGEST_MIN_DAY} to ${INGEST_MAX_DAY})
            --from, --to
                     a range of publication days, both included, at most ${String(INGEST_MAX_DAYS)} days
            --limit  max records per notice type and day, 1-${String(INGEST_MAX_LIMIT)}, default ${String(INGEST_DEFAULT_LIMIT)}
  profile:create <file.json>
            Create a company profile from a JSON file (at most ${String(PROFILE_FILE_MAX_BYTES / 1024)} KiB) with every field:
            email, name, categories (at least one MVP category), includeKeywords,
            excludeKeywords, voivodeships, counties, active. Prints the new profile's id.
            Region: an offer matches when any listed voivodeship OR county matches; it is
            out of region only when every list used is known for the offer. BZP gives no
            county, so with counties listed a BZP offer from another voivodeship is
            "unknown" (needs category + keyword, 70 points) instead of out of region.
            Exit 2 for an unreadable or invalid file, 1 when the e-mail is already used.
  profile:show <profileId>
            Print a company profile as JSON.
  match:preview <profileId> [--limit N]
            Match the newest offers that are not closed or cancelled against a profile and
            print the matched ones (deadline first) with score and reasons, then
            "dopasowane X z Y"; nothing is stored or sent. Works for inactive profiles too.
            Offers past their deadline are listed last, marked "(po terminie)". A stored
            offer row that is no longer valid is skipped with a warning on stderr (row id
            and field names) and counted in the summary ("pominięto N ...").
            --limit  offers to read, 1-${String(MATCH_PREVIEW_MAX_LIMIT)}, default ${String(MATCH_PREVIEW_DEFAULT_LIMIT)}
`;

type Command =
  | "health"
  | "migrate"
  | "source:preview"
  | "ingest"
  | "profile:create"
  | "profile:show"
  | "match:preview";
const commands: readonly Command[] = [
  "health",
  "migrate",
  "source:preview",
  "ingest",
  "profile:create",
  "profile:show",
  "match:preview",
];

function isCommand(value: string): value is Command {
  return (commands as readonly string[]).includes(value);
}

interface PreviewArgs {
  readonly adapter: SourceAdapter;
  readonly publicationDate: string;
  readonly limit: number;
}

/** `date`: --date; `range`: --from/--to; `catch_up`: neither (the default, D-021). */
type IngestDays =
  | { readonly mode: "date"; readonly date: string }
  | { readonly mode: "range"; readonly from: string; readonly to: string }
  | { readonly mode: "catch_up" };

interface IngestArgs {
  /** Empty: every enabled source. */
  readonly sourceIds: readonly string[];
  readonly days: IngestDays;
  readonly limit: number;
}

interface MatchPreviewArgs {
  readonly profileId: string;
  readonly limit: number;
}

type Invocation =
  | { readonly command: "health" | "migrate" }
  | { readonly command: "source:preview"; readonly preview: PreviewArgs }
  | { readonly command: "ingest"; readonly ingest: IngestArgs }
  | { readonly command: "profile:create"; readonly file: string }
  | { readonly command: "profile:show"; readonly profileId: string }
  | { readonly command: "match:preview"; readonly match: MatchPreviewArgs };

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

const INGEST_DAY_OPTIONS = ["--date", "--from", "--to"] as const;
type IngestDayOption = (typeof INGEST_DAY_OPTIONS)[number];

function isIngestDayOption(value: string): value is IngestDayOption {
  return (INGEST_DAY_OPTIONS as readonly string[]).includes(value);
}

/** The day options as given (each already a calendar date) → the days, or a usage error. */
function ingestDays(dates: ReadonlyMap<IngestDayOption, string>): IngestDays | string {
  const date = dates.get("--date");
  const from = dates.get("--from");
  const to = dates.get("--to");
  if (date !== undefined) {
    if (from !== undefined || to !== undefined) {
      return "Option --date cannot be combined with --from/--to.";
    }
    return { mode: "date", date };
  }
  if (from === undefined && to === undefined) return { mode: "catch_up" };
  if (from === undefined || to === undefined) {
    return "Options --from and --to must be given together.";
  }
  if (from > to) return "--from must not be after --to.";
  // Counted, never listed: a wide range is refused without building it.
  if (daySpan(from, to) > INGEST_MAX_DAYS) {
    return `--from/--to may cover at most ${String(INGEST_MAX_DAYS)} days.`;
  }
  return { mode: "range", from, to };
}

/**
 * `ingest [sourceId...] [--date D | --from A --to B] [--limit N]`. Source
 * ids must be supported by this build (enabled in the database is checked
 * later, before any fetch). Returns the parsed arguments or a usage error
 * message.
 */
function parseIngestArgs(args: readonly string[], sources: CliSourceDeps): IngestArgs | string {
  const sourceIds: string[] = [];
  const dates = new Map<IngestDayOption, string>();
  let limit: number | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) {
      if (!sources.adapters.has(arg)) return `Unknown source: ${JSON.stringify(arg)}`;
      if (sourceIds.includes(arg)) return `Source ${JSON.stringify(arg)} given twice.`;
      sourceIds.push(arg);
      continue;
    }
    if (!isIngestDayOption(arg) && arg !== "--limit") {
      return `Unexpected argument: ${JSON.stringify(arg)}`;
    }
    const value = args[index + 1];
    if (value === undefined) return `Option ${arg} needs a value.`;
    index++;
    if (isIngestDayOption(arg)) {
      if (dates.has(arg)) return `Option ${arg} given twice.`;
      if (!isCalendarDate(value)) return `${arg} must be a calendar date YYYY-MM-DD.`;
      if (!isIngestDay(value)) {
        return `${arg} must be a day from ${INGEST_MIN_DAY} to ${INGEST_MAX_DAY}.`;
      }
      dates.set(arg, value);
    } else {
      if (limit !== null) return "Option --limit given twice.";
      if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > INGEST_MAX_LIMIT) {
        return `--limit must be an integer from 1 to ${String(INGEST_MAX_LIMIT)}.`;
      }
      limit = Number(value);
    }
  }
  const days = ingestDays(dates);
  if (typeof days === "string") return days;
  return { sourceIds, days, limit: limit ?? INGEST_DEFAULT_LIMIT };
}

/** A profile id argument: a uuid (the id is not echoed back, it is operator input). */
function parseProfileId(value: string | undefined): string | null {
  if (value === undefined || value.startsWith("-")) return null;
  return entityIdSchema.safeParse(value).success ? value : null;
}

/** `match:preview <profileId> [--limit N]`; returns the parsed arguments or a usage error. */
function parseMatchPreviewArgs(args: readonly string[]): MatchPreviewArgs | string {
  const [id, ...options] = args;
  const profileId = parseProfileId(id);
  if (profileId === null) return 'Command "match:preview" needs a profile id (uuid).';
  let limit: number | null = null;
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index] ?? "";
    const value = options[index + 1];
    if (name !== "--limit") return `Unexpected argument: ${JSON.stringify(name)}`;
    if (value === undefined) return `Option ${name} needs a value.`;
    if (limit !== null) return "Option --limit given twice.";
    if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > MATCH_PREVIEW_MAX_LIMIT) {
      return `--limit must be an integer from 1 to ${String(MATCH_PREVIEW_MAX_LIMIT)}.`;
    }
    limit = Number(value);
  }
  return { profileId, limit: limit ?? MATCH_PREVIEW_DEFAULT_LIMIT };
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
  if (command === "profile:create") {
    const [file, ...extra] = rest;
    if (file === undefined || file.startsWith("-")) {
      return 'Command "profile:create" needs a profile file (JSON).';
    }
    if (extra.length > 0) return `Unexpected argument: ${JSON.stringify(extra[0])}`;
    return { command, file };
  }
  if (command === "profile:show") {
    const [id, ...extra] = rest;
    const profileId = parseProfileId(id);
    if (profileId === null) return 'Command "profile:show" needs a profile id (uuid).';
    if (extra.length > 0) return `Unexpected argument: ${JSON.stringify(extra[0])}`;
    return { command, profileId };
  }
  if (command === "match:preview") {
    const match = parseMatchPreviewArgs(rest);
    return typeof match === "string" ? match : { command, match };
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

  // The profile file is part of the invocation: an unreadable or invalid file
  // is a usage error (exit 2), found before the configuration is loaded.
  let profileInput: CompanyProfileInput | null = null;
  if (invocation.command === "profile:create") {
    const loaded = await readProfileFile(invocation.file);
    if (typeof loaded === "string") {
      io.stderr(`${loaded}\n`);
      return ExitCode.Usage;
    }
    profileInput = loaded;
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
      case "profile:create":
        if (profileInput === null) throw new Error("profile input was not read");
        return await runProfileCreate(profileInput, database, io);
      case "profile:show":
        return await runProfileShow(invocation.profileId, database, io);
      case "match:preview":
        return await runMatchPreview(config, invocation.match, database, io, sources);
    }
  } finally {
    await database.close();
  }
}

async function runHealth(config: AppConfig, database: CliDatabase, io: CliIo): Promise<ExitCode> {
  if (database.pendingMigrations === undefined) {
    throw new Error("database cannot check migrations");
  }
  const report = await checkHealth(config, {
    ping: () => database.ping(),
    pendingMigrations: database.pendingMigrations.bind(database),
  });
  io.stdout(`${JSON.stringify(report)}\n`);
  if (report.database.status === "error") {
    io.stderr(`Database check failed: ${formatDatabaseFailure(report.database)}\n`);
  } else if (report.schema.status === "error") {
    const why =
      report.schema.reason === "not_migrated"
        ? "not migrated; run `migrate`"
        : formatDatabaseFailure(report.schema);
    io.stderr(`Schema check failed: ${why}\n`);
  }
  return report.status === "ok" ? ExitCode.Ok : ExitCode.Failure;
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
 * A notice update as `source:preview` lists it: the new deadline it carries,
 * or why ingestion would skip it on its own. Whether an original is stored
 * (`no_original`) or a later update applied (`superseded`) is only known when
 * ingesting: nothing is read from the database here.
 */
function previewUpdate(update: NoticeUpdate) {
  const { change } = update;
  const skipReason =
    update.tenderId === null ? "no_tender_id" : change.kind === "none" ? change.reason : null;
  return {
    externalId: update.externalId,
    tenderId: update.tenderId,
    publishedAt: update.publishedAt,
    deadline: change.kind === "deadline" ? change.deadline : null,
    skipReason,
  };
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
    noticeUpdates: preview.updates.length,
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
    updates: preview.updates.map(previewUpdate),
  };
  io.stdout(`${JSON.stringify(report)}\n`);
  return ExitCode.Ok;
}

/**
 * `ingest`: runs the sources under the ingest lock (one run at a time, D-019)
 * over the requested days or catch-up (D-021) and prints a JSON summary on
 * stdout. Each source's run per day is stored in
 * `ingestion_runs` and logged (sourceId, status, counters, duration) by
 * runIngestion. Exit 0 when every source succeeded or was incomplete, and
 * when another run holds the lock (status `skipped`, reason `lock_busy`:
 * nothing fetched or recorded — an overlapping cron run is not an error,
 * D-019); 1 when any source failed, a run could not be recorded, the lock was
 * lost during the run (the run is aborted, `lock_lost`), the schema is not
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
  const { days } = args;
  const request: IngestionRequest = {
    ...(args.sourceIds.length > 0 ? { sourceIds: args.sourceIds } : {}),
    days:
      days.mode === "date"
        ? { mode: "range", from: days.date, to: days.date }
        : days.mode === "range"
          ? days
          : { mode: "catch_up" },
    maxRecords: args.limit,
  };
  // Known up front except for catch-up, whose days are planned under the lock.
  const requested =
    request.days.mode === "range"
      ? { from: request.days.from, to: request.days.to }
      : { from: null, to: null };

  let locked: LockResult<IngestionOutcome>;
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
    // The normal report's fields plus `reason`; no ingestion_runs row (nothing ran).
    const skipped = {
      status: "skipped",
      reason: "lock_busy",
      mode: days.mode,
      ...requested,
      limit: args.limit,
      runs: [],
      notRun: [],
      clipped: [],
    };
    io.stdout(`${JSON.stringify(skipped)}\n`);
    io.stderr("Ingest skipped: another ingest run holds the lock; nothing was fetched.\n");
    return ExitCode.Ok;
  }
  const outcome = locked.value;
  const { runs } = outcome;
  // Without the lock another run may have started: never report success.
  const status = locked.lockLost ? "failed" : overallStatus(runs);
  const report = {
    status,
    mode: days.mode,
    from: outcome.from,
    to: outcome.to,
    limit: args.limit,
    runs: runs.map((run) => ({
      sourceId: run.sourceId,
      publicationDate: run.publicationDate,
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.finishedAt.getTime() - run.startedAt.getTime(),
      ...run.counters,
      skippedReasons: run.skippedReasons,
      incomplete: run.incomplete,
      errorCode: run.errorCode,
    })),
    notRun: outcome.notRun,
    clipped: outcome.clipped,
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

/**
 * A refused profile read or write, or a database failure, as a fixed message
 * (DomainError messages carry field paths and constraint names only); null
 * for anything else, which is a bug and propagates.
 */
function profileFailure(error: unknown): string | null {
  if (error instanceof DomainError) {
    return error.code === "duplicate"
      ? "a profile with this e-mail already exists"
      : `${error.message} (${error.code})`;
  }
  const failure = describeDatabaseFailure(error);
  return failure.reason === "unknown" ? null : `database ${formatDatabaseFailure(failure)}`;
}

/** `profile:create`: stores the validated profile and prints its id. */
async function runProfileCreate(
  input: CompanyProfileInput,
  database: CliDatabase,
  io: CliIo,
): Promise<ExitCode> {
  if (database.createCompanyProfile === undefined) {
    throw new Error("database cannot create profiles");
  }
  let profile: CompanyProfile;
  try {
    profile = await database.createCompanyProfile(input);
  } catch (error: unknown) {
    const why = profileFailure(error);
    if (why === null) throw error;
    io.stderr(`Profile not created: ${why}\n`);
    return ExitCode.Failure;
  }
  io.stdout(`${JSON.stringify({ status: "ok", id: profile.id })}\n`);
  return ExitCode.Ok;
}

/** Reads one profile; prints why and returns null when it cannot be shown. */
async function loadProfile(
  profileId: string,
  database: CliDatabase,
  io: CliIo,
): Promise<CompanyProfile | null> {
  if (database.getCompanyProfile === undefined) throw new Error("database cannot read profiles");
  try {
    const profile = await database.getCompanyProfile(profileId);
    if (profile === null) io.stderr("Profile not found.\n");
    return profile;
  } catch (error: unknown) {
    const why = profileFailure(error);
    if (why === null) throw error;
    io.stderr(`Cannot read the profile: ${why}\n`);
    return null;
  }
}

/** `profile:show`: the stored profile as JSON; exit 1 when there is none. */
async function runProfileShow(
  profileId: string,
  database: CliDatabase,
  io: CliIo,
): Promise<ExitCode> {
  const profile = await loadProfile(profileId, database, io);
  if (profile === null) return ExitCode.Failure;
  io.stdout(showProfile(profile));
  return ExitCode.Ok;
}

/**
 * `match:preview`: the newest offers that are not closed or cancelled,
 * matched against the profile (src/matching), printed as text. Read-only:
 * nothing is stored or sent. Contact data is never printed. An invalid
 * stored offer row is skipped (a warning with its id and field paths, never
 * values; the summary counts it) and the exit code stays 0; an invalid
 * profile row still fails the command.
 */
async function runMatchPreview(
  config: AppConfig,
  args: MatchPreviewArgs,
  database: CliDatabase,
  io: CliIo,
  sources: CliSourceDeps,
): Promise<ExitCode> {
  if (database.listMatchCandidates === undefined) {
    throw new Error("database cannot list match candidates");
  }
  const profile = await loadProfile(args.profileId, database, io);
  if (profile === null) return ExitCode.Failure;
  let candidates: MatchCandidates;
  try {
    candidates = await database.listMatchCandidates(args.limit);
  } catch (error: unknown) {
    const why = profileFailure(error);
    if (why === null) throw error;
    io.stderr(`Cannot read offers: ${why}\n`);
    return ExitCode.Failure;
  }
  if (candidates.skipped.length > 0) {
    const logger = createLogger(config.logLevel, io.stderr);
    for (const row of candidates.skipped) {
      logger.warn("match:preview skipped an invalid stored offer", {
        rowId: row.id,
        fields: row.fields,
      });
    }
  }
  io.stdout(
    formatMatchPreview(profile, candidates.offers, {
      now: sources.now(),
      skipped: candidates.skipped.length,
    }),
  );
  return ExitCode.Ok;
}

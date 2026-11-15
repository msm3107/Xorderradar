import type { Kysely } from "kysely";
import { setTimeout as sleep } from "node:timers/promises";
import { entityIdSchema } from "./domain/common.js";
import type { CompanyProfile, CompanyProfileInput } from "./domain/company-profile.js";
import { DomainError } from "./domain/errors.js";
import type { NoticeUpdate } from "./domain/notice-update.js";
import { checkHealth } from "./health.js";
import {
  ConfigError,
  loadConfig,
  loadContactEmail,
  loadEmailConfig,
  loadEmailMode,
  loadOperatorEmail,
  loadPublicBaseUrl,
  loadStatusConfig,
  loadWebConfig,
  type AppConfig,
  type EmailConfig,
  type StatusConfig,
  type WebConfig,
} from "./infrastructure/config.js";
import {
  getProfileStatus,
  issueAccessToken,
  type IssuedToken,
  revokeProfileAccess,
  type RevokedAccess,
} from "./infrastructure/db/access-repository.js";
import {
  createDatabase,
  MigrationError,
  migrateToLatest,
  pendingMigrations,
  pingDatabase,
} from "./infrastructure/db/database.js";
import { describeDatabaseFailure, formatDatabaseFailure } from "./infrastructure/db/errors.js";
import type { Database, DeliveryTransport } from "./infrastructure/db/schema.js";
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
  listPendingDeliveries,
  resolvePendingDeliveries,
  type PendingDeliveries,
  type ResolveRequest,
  type ResolveResult,
} from "./infrastructure/db/deliveries-repository.js";
import { countFeedback, type FeedbackCounts } from "./infrastructure/db/feedback-repository.js";
import {
  listMatchCandidates,
  type MatchCandidates,
} from "./infrastructure/db/opportunities-repository.js";
import { createLogger, type Logger } from "./infrastructure/logger.js";
import { MIN_INFLECTED_TOKEN_LENGTH } from "./matching/text.js";
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
  profileWarnings,
  MATCH_PREVIEW_DEFAULT_LIMIT,
  MATCH_PREVIEW_MAX_LIMIT,
  PROFILE_FILE_MAX_BYTES,
  readProfileFile,
  showProfile,
} from "./profile-commands.js";
import {
  DIGEST_LOCK_KEY,
  DIGEST_MAX_ATTEMPTS,
  DIGEST_MAX_ITEMS,
  DIGEST_NEW_DAYS,
  digestFailed,
  profileFailed,
  runDigest,
  withDigestLock,
  type DigestSummary,
} from "./notifications/run.js";
import {
  createEmailSender,
  sendWithRetry,
  type EmailSender,
  type SendResult,
} from "./notifications/sender.js";
import {
  BackupError,
  backupDatabase,
  restoreDatabase,
  type BackupFailureReason,
  type BackupResult,
  readBackupDirectory,
  type RestoreResult,
  type ToolOptions,
} from "./operations/backup.js";
import { buildFeedbackReport } from "./operations/feedback-report.js";
import { sendHeartbeat, type HeartbeatResult } from "./operations/heartbeat.js";
import {
  BACKUP_STALE_AFTER_MS,
  collectStatus,
  failedStatus,
  formatOperatorAlert,
  STATUS_STALE_AFTER_MS,
  withBackupCheck,
  type StatusReport,
} from "./operations/status.js";
import { previewSource, type SourcePreview } from "./sources/preview.js";
import { loginUrl } from "./web/links.js";
import { startWebServer, type WebServer, type WebServerOptions } from "./web/server.js";
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
  /**
   * Runs `task` with the pool while holding the digest advisory lock
   * (src/notifications/run.ts), like withIngestLock. Optional only so that
   * stubs for the other commands need not provide it.
   */
  withDigestLock?<T>(
    task: (db: Kysely<Database>, signal: AbortSignal) => Promise<T>,
    logger: Logger,
  ): Promise<LockResult<T>>;
  /**
   * A new single-use login token for the profile (`access:link`); null when
   * the profile does not exist. Optional only so that stubs for the other
   * commands need not provide it.
   */
  issueLoginToken?(profileId: string): Promise<IssuedToken | null>;
  /**
   * Deletes every token and session of the profile (`access:revoke`) and
   * returns the counts; null when the profile does not exist. Optional only
   * so that stubs for the other commands need not provide it.
   */
  revokeProfileAccess?(profileId: string): Promise<RevokedAccess | null>;
  /**
   * Starts the web server on this pool (`serve`, src/web/server.ts).
   * Optional only so that stubs for the other commands need not provide it.
   */
  startWebServer?(options: Omit<WebServerOptions, "db">): Promise<WebServer>;
  /**
   * The pending deliveries (`deliveries:pending`) and the operator's decision
   * on them (`deliveries:resolve`, under the digest lock; D-024). Optional
   * only so that stubs for the other commands need not provide them.
   */
  listPendingDeliveries?(): Promise<PendingDeliveries>;
  resolvePendingDeliveries?(request: Omit<ResolveRequest, "digestLockKey">): Promise<ResolveResult>;
  /**
   * The operator's status report (`status`, src/operations/status.ts).
   * Optional only so that stubs for the other commands need not provide it.
   */
  collectStatus?(now: Date): Promise<StatusReport>;
  /**
   * `backup` and `restore` (src/operations/backup.ts) on this database.
   * Optional only so that stubs for the other commands need not provide them.
   */
  backup?(dir: string, now: Date, options: ToolOptions): Promise<BackupResult>;
  restore?(file: string, options: ToolOptions): Promise<RestoreResult>;
  /**
   * The customers' ratings counted per profile and per CPV codes
   * (`feedback:report`, PR-12). Optional only so that stubs for the other
   * commands need not provide it.
   */
  countFeedback?(since: string | null): Promise<FeedbackCounts>;
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

/** What `digest` needs besides the database; injected so tests never send e-mail. */
export interface CliDigestDeps {
  /** Called once per non-dry run, after the configuration was validated. */
  readonly createSender: (config: EmailConfig) => EmailSender;
  readonly now: () => Date;
  /** The pause between in-run retries of a transient send failure. */
  readonly sleep: (ms: number) => Promise<void>;
  /** RETRY_DELAYS_MS when absent. */
  readonly retryDelaysMs?: readonly number[];
}

/** What `serve` needs besides the database; injected so tests can stop the server. */
export interface CliWebDeps {
  /** Resolves when the server should shut down (SIGINT or SIGTERM in production). */
  readonly waitForShutdown: () => Promise<void>;
}

/** What `status` sends besides the alert; injected so tests never ping the network. */
export interface CliStatusDeps {
  /** One heartbeat ping of HEARTBEAT_URL (src/operations/heartbeat.ts); never throws. */
  readonly ping: (url: string) => Promise<HeartbeatResult>;
}

/** External dependencies, injected so the CLI can be unit-tested without PostgreSQL. */
export interface CliDeps {
  /** Must not connect yet; connecting happens on the first operation. */
  readonly openDatabase: (databaseUrl: string) => CliDatabase;
  /** Defaults to defaultSourceDeps (the real network); tests inject fakes. */
  readonly sources?: CliSourceDeps;
  /** Defaults to defaultDigestDeps (real e-mail per EMAIL_MODE); tests inject fakes. */
  readonly digest?: CliDigestDeps;
  /** Defaults to defaultWebDeps (process signals); tests inject a promise they resolve. */
  readonly web?: CliWebDeps;
  /** Defaults to defaultStatusDeps (a real HTTPS ping); tests inject a fake. */
  readonly status?: CliStatusDeps;
}

/**
 * Bounds a whole `source:preview` run. Its default limit needs one request per
 * notice type (3 for BZP); the 500-record maximum (per notice type) up to
 * 3 × 20 requests at >= 2 s each (>= 120 s). Baza Konkurencyjności reads one
 * detail per announcement (D-030): its default 20 records are ~22 requests
 * (~1 min); past ~100 records a preview runs into this bound (`source_timeout`).
 */
export const SOURCE_RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Bounds one source and one publication day within `ingest` (D-018, D-030).
 * The default limit of 1000 records per notice type is at most 3 × 40 pages
 * for BZP (contract notices, small contracts, notice updates), i.e. 120
 * requests spaced >= 2 s apart (>= 240 s) plus response and write time.
 * Baza Konkurencyjności needs one request per announcement: at most
 * BK_MAX_DETAILS_PER_DAY (250) details plus at most 4 listing pages (1 on a
 * day of up to 250), i.e. <= 254 requests at ~2.9 s each measured (~12.5 min);
 * 15 minutes leaves about 3.5 s per request. Sources run in id order (bk
 * before bzp): a typical bk day (~180 announcements) takes ~9 min, then BZP a
 * few minutes, so the 06:00 `ingest` ends well before the 06:30 `status`;
 * even both sources at their request bounds (bk 254, BZP 120 requests at
 * ~2.9 s: ~12.5 + ~6 min) end by about 06:20. A run covers up to
 * INGEST_MAX_DAYS days, each with its own timeout: the worst case is 31 × 15
 * min per source (D-021), and BZP starts only after all of bk's days — up to
 * 15 min × the number of bk days caught up (D-030).
 */
export const INGEST_SOURCE_TIMEOUT_MS = 15 * 60_000;

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

/** Production `digest` wiring: the sender EMAIL_MODE selects, the real clock. */
export const defaultDigestDeps: CliDigestDeps = {
  createSender: createEmailSender,
  now: () => new Date(),
  sleep: async (ms) => {
    await sleep(ms);
  },
};

/** Production `status` wiring: the heartbeat over node:https. */
export const defaultStatusDeps: CliStatusDeps = {
  ping: (url) => sendHeartbeat(url),
};

/**
 * Production `serve` wiring: the first SIGINT or SIGTERM starts the graceful
 * shutdown. The listeners are added only while `serve` waits (never at module
 * load) and removed after, so a second signal stops the process at once.
 */
export const defaultWebDeps: CliWebDeps = {
  waitForShutdown: () =>
    new Promise((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }),
};

/**
 * A real connection pool (src/infrastructure/db). `lockHeartbeatMs` exists for
 * integration tests; production uses INGEST_LOCK_HEARTBEAT_MS (and the digest
 * lock's own default).
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
    withDigestLock: (task, logger) =>
      withDigestLock(db, (signal) => task(db, signal), {
        logger,
        ...(options.lockHeartbeatMs === undefined ? {} : { heartbeatMs: options.lockHeartbeatMs }),
      }),
    issueLoginToken: async (profileId) =>
      (await getProfileStatus(db, profileId)) === null
        ? null
        : issueAccessToken(db, profileId, "login"),
    revokeProfileAccess: async (profileId) =>
      (await getProfileStatus(db, profileId)) === null ? null : revokeProfileAccess(db, profileId),
    startWebServer: (webOptions) => startWebServer({ db, ...webOptions }),
    listPendingDeliveries: () => listPendingDeliveries(db),
    resolvePendingDeliveries: (request) =>
      resolvePendingDeliveries(db, { ...request, digestLockKey: DIGEST_LOCK_KEY }),
    collectStatus: (now) => collectStatus(db, now),
    backup: (dir, now, toolOptions) => backupDatabase(db, databaseUrl, dir, now, toolOptions),
    restore: (file, toolOptions) => restoreDatabase(db, databaseUrl, file, toolOptions),
    countFeedback: (since) => countFeedback(db, since),
  };
}

/** Production wiring. */
export const defaultCliDeps: CliDeps = {
  sources: defaultSourceDeps,
  digest: defaultDigestDeps,
  web: defaultWebDeps,
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
            Region: a known offer voivodeship outside the profile's voivodeships is out of
            region, whatever the county (counties never widen such a profile). Within a
            listed voivodeship the voivodeship decides; narrowing by county is not
            implemented (no source gives counties yet). Counties take effect on their own
            only when the offer gives no voivodeship or in a profile without voivodeships:
            BZP gives no county, so a profile without voivodeships
            gets BZP offers from the whole country as "unknown" (category + keyword, 70).
            After creating, warns on stderr about counties without voivodeships, keywords
            that only match their exact form (shorter than ${String(MIN_INFLECTED_TOKEN_LENGTH)} characters) and no keywords.
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
  digest [--dry-run] [--profile <profileId>]
            Send today's digest: per active profile at most one e-mail a day (Poland's
            calendar day) with the matching offers first stored in the last ${String(DIGEST_NEW_DAYS)} days that
            are not closed or cancelled, not past their deadline (unknown kept) and never
            sent to the profile before; at most ${String(DIGEST_MAX_ITEMS)} per e-mail, soonest deadline first (the
            rest waits, "overflow"). No e-mail when there is nothing new. EMAIL_MODE=test
            (default) writes each e-mail to EMAIL_OUTBOX_DIR (default ./outbox) and sends
            nothing; EMAIL_MODE=smtp sends through SMTP_URL from EMAIL_FROM. Each offer goes
            to a profile at most once: it is claimed before sending, so a send interrupted
            without an answer is reported "uncertain" and never repeated; a failed send is
            tried again by later runs, at most ${String(DIGEST_MAX_ATTEMPTS)} times. Prints one JSON summary with
            counts per profile (never addresses or e-mail content). One run at a time
            (lock): while another run holds it, prints status "skipped" and exits 0.
            Requires an up-to-date schema (migrate). Exit 1 when a send failed or is
            uncertain, a profile is missing or invalid, or the lock was lost.
            --dry-run   build the digests and print the summary; nothing is claimed,
                        sent or written to the outbox
            --profile   only this profile (also when it has nothing new)
            With PUBLIC_BASE_URL set, every e-mail also carries a single-use login link
            ("Twój profil", 7 days), a one-click unsubscribe link (RFC 8058, 60 days) and
            under every offer the rating links "Trafne"/"Nietrafne" (one multi-use link
            token per e-mail, 60 days).
  deliveries:pending
            Print the deliveries waiting for an operator decision (status pending: a send
            with an unknown outcome or a run stopped between claim and send) as JSON, per
            profile, transport and digest day: profileId, transport, digestDate, offers and
            the oldest claim time (oldestCreatedAt). Ids and counts only. Requires an
            up-to-date schema (migrate).
  deliveries:resolve <profileId> --sent|--failed [--date YYYY-MM-DD] [--transport test|smtp]
            Record the operator's decision on the profile's pending deliveries of one
            transport (all of them, or those of one digest day), in one transaction; other
            rows never change.
            --sent       the e-mail arrived: the rows become sent (sent_at now, attempts + 1)
            --failed     it did not: the rows are deleted, so the next digest sends those
                         offers as new (if they still qualify)
            --date       only the pending rows of this digest day
            --transport  only the rows of this transport (default: EMAIL_MODE's, like digest;
                         EMAIL_FROM and SMTP_URL are not needed)
            Prints the transport and the number of rows changed as JSON. Refused (exit 1,
            nothing changed) while a digest or another deliveries:resolve runs (the digest
            lock) or when there is no pending row to change.
            Exactly one of --sent and --failed (exit 2 otherwise).
  serve     Run the web server (profile access through e-mail links, one-click
            unsubscribe) until SIGINT/SIGTERM. Listens on WEB_HOST:WEB_PORT (default
            127.0.0.1:3000) behind a reverse proxy that terminates TLS. Requires
            PUBLIC_BASE_URL and an up-to-date schema (migrate). Deletes expired links and
            sessions hourly. Exit 1 when it cannot start.
  access:link <profileId>
            Print a new single-use login link for the profile (valid 7 days) as JSON. The
            link is a secret: whoever opens it gets into the profile; hand it over only
            to the profile's owner. Requires PUBLIC_BASE_URL. Exit 1 when the profile
            does not exist.
  access:revoke <profileId>
            End every login, unsubscribe and rating link and every session of the profile at once
            (e.g. after a forwarded e-mail or a lost device) and print the counts as JSON.
            The profile and its notifications stay as they are; a new link comes from
            access:link or the next digest. Requires an up-to-date schema (migrate). Exit 1
            when the profile does not exist.
  status [--notify]
            Print one JSON line on what the operator must know: per enabled source its last
            run and its last succeeded/incomplete run, the failed days not covered since
            (last ${String(STATUS_STALE_AFTER_MS / 3_600_000)} h), and the pending and recently failed deliveries. Problems:
            source_failed, source_stale (no success in ${String(STATUS_STALE_AFTER_MS / 3_600_000)} h), source_never_run,
            source_incomplete (the two newest non-failed runs, of two days, both incomplete;
            the alert lists their part: reason codes), no_enabled_sources, deliveries_pending, deliveries_failed, schema_not_ready,
            database_unavailable; with BACKUP_DIR set also backup_dir_unreadable, backup_missing
            and backup_stale (newest radar-<UTC time>.dump older than ${String(BACKUP_STALE_AFTER_MS / 3_600_000)} h).
            Read-only; run it after ingest and after digest (cron). Exit 0 when there is no
            problem, 1 otherwise. With HEARTBEAT_URL set (https), an exit-0 run then sends one
            GET to it (dead man's switch; with or without --notify); a failed ping is logged
            and reported as heartbeat "failed" but keeps exit 0.
            --notify  when there is a problem, also send one plain-text alert (ids, codes,
                      timestamps and counts only) to OPERATOR_EMAIL over EMAIL_MODE (test:
                      the outbox); exit 1 also when it cannot be sent. An unexpected error
                      of status itself is alerted as status_internal_error (no details).
  feedback:report [--since YYYY-MM-DD]
            Print the customers' ratings of offers ("Trafne"/"Nietrafne", from the e-mails
            and the web list) as one JSON line: the counts and the precision (the relevant
            share, null without ratings) in total, per profile (by id) and per category of
            the rated offers (by their CPV codes; null: none of the categories). In total
            and per profile also the coverage: delivered (distinct offers sent), ratedDelivered
            (of those, rated) and coverage (their share, null with nothing sent). Ids,
            categories and counts only, never addresses or titles. Read-only. Requires an
            up-to-date schema (migrate).
            --since  only ratings last set and offers sent on or after this day
                     (Poland's time)
  backup <dir>
            Dump the database schema (pg_dump >= 16, custom format, no owners or
            privileges) into a new file <dir>/radar-<UTC time>.dump readable by the owner
            only, and print its path and size as JSON. The file holds personal data.
            Exit 1 when the dump fails (nothing is left behind).
  restore <file>
            Restore a backup (pg_restore >= 16, one transaction) into the schema of
            DATABASE_URL, only when that schema exists and is empty; then check the
            schema like health and print the row count per table as JSON. Exit 1 when
            the target is not empty, the restore fails or migrations are pending.
`;

type Command =
  | "health"
  | "migrate"
  | "source:preview"
  | "ingest"
  | "profile:create"
  | "profile:show"
  | "match:preview"
  | "digest"
  | "deliveries:pending"
  | "deliveries:resolve"
  | "serve"
  | "access:link"
  | "access:revoke"
  | "status"
  | "feedback:report"
  | "backup"
  | "restore";
const commands: readonly Command[] = [
  "health",
  "migrate",
  "source:preview",
  "ingest",
  "profile:create",
  "profile:show",
  "match:preview",
  "digest",
  "deliveries:pending",
  "deliveries:resolve",
  "serve",
  "access:link",
  "access:revoke",
  "status",
  "feedback:report",
  "backup",
  "restore",
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

interface ResolveArgs {
  readonly profileId: string;
  readonly outcome: "sent" | "failed";
  /** null: every pending row of the profile and transport. */
  readonly digestDate: string | null;
  /** null: not given — the transport of EMAIL_MODE, read with the configuration. */
  readonly transport: DeliveryTransport | null;
}

interface DigestArgs {
  readonly dryRun: boolean;
  /** null: every active profile. */
  readonly profileId: string | null;
}

type Invocation =
  | { readonly command: "health" | "migrate" | "serve" | "deliveries:pending" }
  | { readonly command: "access:link" | "access:revoke"; readonly profileId: string }
  | { readonly command: "source:preview"; readonly preview: PreviewArgs }
  | { readonly command: "ingest"; readonly ingest: IngestArgs }
  | { readonly command: "profile:create"; readonly file: string }
  | { readonly command: "profile:show"; readonly profileId: string }
  | { readonly command: "match:preview"; readonly match: MatchPreviewArgs }
  | { readonly command: "digest"; readonly digest: DigestArgs }
  | { readonly command: "deliveries:resolve"; readonly resolve: ResolveArgs }
  | { readonly command: "status"; readonly notify: boolean }
  | { readonly command: "feedback:report"; readonly since: string | null }
  | { readonly command: "backup"; readonly dir: string }
  | { readonly command: "restore"; readonly file: string };

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

/** `digest [--dry-run] [--profile <id>]`; returns the parsed arguments or a usage error. */
function parseDigestArgs(args: readonly string[]): DigestArgs | string {
  let dryRun = false;
  let profileId: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--dry-run") {
      if (dryRun) return "Option --dry-run given twice.";
      dryRun = true;
    } else if (arg === "--profile") {
      if (profileId !== null) return "Option --profile given twice.";
      profileId = parseProfileId(args[index + 1]);
      if (profileId === null) return "Option --profile needs a profile id (uuid).";
      index++;
    } else {
      return `Unexpected argument: ${JSON.stringify(arg)}`;
    }
  }
  return { dryRun, profileId };
}

/**
 * `deliveries:resolve <profileId> --sent|--failed [--date YYYY-MM-DD]
 * [--transport test|smtp]`; returns the parsed arguments or a usage error message.
 */
function parseResolveArgs(args: readonly string[]): ResolveArgs | string {
  const [id, ...options] = args;
  const profileId = parseProfileId(id);
  if (profileId === null) return 'Command "deliveries:resolve" needs a profile id (uuid).';
  let outcome: "sent" | "failed" | null = null;
  let digestDate: string | null = null;
  let transport: DeliveryTransport | null = null;
  for (let index = 0; index < options.length; index++) {
    const arg = options[index] ?? "";
    if (arg === "--sent" || arg === "--failed") {
      if (outcome !== null) return "Give exactly one of --sent and --failed.";
      outcome = arg === "--sent" ? "sent" : "failed";
    } else if (arg === "--date") {
      if (digestDate !== null) return "Option --date given twice.";
      const value = options[index + 1];
      if (value === undefined) return "Option --date needs a value.";
      if (!isCalendarDate(value)) return "--date must be a calendar date YYYY-MM-DD.";
      digestDate = value;
      index++;
    } else if (arg === "--transport") {
      if (transport !== null) return "Option --transport given twice.";
      const value = options[index + 1];
      if (value === undefined) return "Option --transport needs a value.";
      if (value !== "test" && value !== "smtp") return "--transport must be test or smtp.";
      transport = value;
      index++;
    } else {
      return `Unexpected argument: ${JSON.stringify(arg)}`;
    }
  }
  if (outcome === null) return "Give exactly one of --sent and --failed.";
  return { profileId, outcome, digestDate, transport };
}

/**
 * `feedback:report [--since YYYY-MM-DD]`: the day (null: every rating) or a
 * usage error message.
 */
function parseFeedbackReportArgs(
  args: readonly string[],
): { readonly since: string | null } | string {
  let since: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg !== "--since") return `Unexpected argument: ${JSON.stringify(arg)}`;
    if (since !== null) return "Option --since given twice.";
    const value = args[index + 1];
    if (value === undefined) return "Option --since needs a value.";
    if (!isCalendarDate(value)) return "--since must be a calendar date YYYY-MM-DD.";
    since = value;
    index++;
  }
  return { since };
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
  if (command === "profile:show" || command === "access:link" || command === "access:revoke") {
    const [id, ...extra] = rest;
    const profileId = parseProfileId(id);
    if (profileId === null) return `Command "${command}" needs a profile id (uuid).`;
    if (extra.length > 0) return `Unexpected argument: ${JSON.stringify(extra[0])}`;
    return { command, profileId };
  }
  if (command === "match:preview") {
    const match = parseMatchPreviewArgs(rest);
    return typeof match === "string" ? match : { command, match };
  }
  if (command === "digest") {
    const digest = parseDigestArgs(rest);
    return typeof digest === "string" ? digest : { command, digest };
  }
  if (command === "deliveries:resolve") {
    const resolve = parseResolveArgs(rest);
    return typeof resolve === "string" ? resolve : { command, resolve };
  }
  if (command === "status") {
    const [option, ...extra] = rest;
    if (option !== undefined && option !== "--notify") {
      return `Unexpected argument: ${JSON.stringify(option)}`;
    }
    if (extra.length > 0) return `Unexpected argument: ${JSON.stringify(extra[0])}`;
    return { command, notify: option === "--notify" };
  }
  if (command === "feedback:report") {
    const report = parseFeedbackReportArgs(rest);
    return typeof report === "string" ? report : { command, since: report.since };
  }
  if (command === "backup" || command === "restore") {
    const [path, ...extra] = rest;
    if (path === undefined || path === "" || path.startsWith("-")) {
      return command === "backup"
        ? 'Command "backup" needs a directory.'
        : 'Command "restore" needs a backup file.';
    }
    if (extra.length > 0) return `Unexpected argument: ${JSON.stringify(extra[0])}`;
    return command === "backup" ? { command, dir: path } : { command, file: path };
  }
  if (rest.length > 0) return `Command "${command}" takes no arguments.`;
  return { command };
}

const CRAWLER_CONTACT_REQUIRED =
  "CRAWLER_CONTACT is required for fetching sources (an e-mail address or https URL).\n";

/** Printed instead of an unexpected error, whose message or stack could carry configuration. */
export const INTERNAL_ERROR_MESSAGE = "Internal error: the command failed unexpectedly.\n";

/**
 * Single entry point for every operational command.
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
  // Only `digest`, `serve` (the access e-mails, D-031) and `status --notify` read
  // the e-mail variables (with the SMTP secrets; `deliveries:resolve` reads
  // EMAIL_MODE alone, below), only `serve` the listener and CONTACT_EMAIL and only
  // the link builders PUBLIC_BASE_URL; checked before the database is opened.
  let emailConfig: EmailConfig | null = null;
  let webConfig: WebConfig | null = null;
  let contactEmail: string | null = null;
  let publicBaseUrl: string | null = null;
  // Only `status --notify` reads OPERATOR_EMAIL (and then the e-mail variables),
  // only `status` BACKUP_DIR and HEARTBEAT_URL.
  let operatorEmail: string | null = null;
  let statusConfig: StatusConfig | null = null;
  // `deliveries:resolve` without --transport reads EMAIL_MODE alone (no SMTP secrets).
  let resolveTransport: DeliveryTransport | null = null;
  const notify = invocation.command === "status" && invocation.notify;
  try {
    config = loadConfig(io.env);
    if (invocation.command === "digest" || invocation.command === "serve" || notify) {
      emailConfig = loadEmailConfig(io.env);
    }
    if (invocation.command === "deliveries:resolve") {
      resolveTransport = invocation.resolve.transport ?? loadEmailMode(io.env);
    }
    if (notify) operatorEmail = loadOperatorEmail(io.env);
    if (invocation.command === "status") statusConfig = loadStatusConfig(io.env);
    if (invocation.command === "serve") {
      webConfig = loadWebConfig(io.env);
      contactEmail = loadContactEmail(io.env);
    }
    if (invocation.command === "digest" || invocation.command === "access:link") {
      publicBaseUrl = loadPublicBaseUrl(io.env);
    }
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return ExitCode.Failure;
    }
    throw error;
  }

  if (notify && operatorEmail === null) {
    io.stderr("OPERATOR_EMAIL is required for status --notify.\n");
    return ExitCode.Failure;
  }

  if (invocation.command === "access:link" && publicBaseUrl === null) {
    io.stderr("PUBLIC_BASE_URL is required for access:link (the links are built from it).\n");
    return ExitCode.Failure;
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
      case "digest":
        if (emailConfig === null) throw new Error("e-mail configuration was not loaded");
        return await runDigestCommand(
          config,
          emailConfig,
          invocation.digest,
          database,
          io,
          deps.digest ?? defaultDigestDeps,
          publicBaseUrl,
        );
      case "deliveries:pending":
        return await runDeliveriesPending(database, io);
      case "feedback:report":
        return await runFeedbackReport(invocation.since, database, io);
      case "deliveries:resolve":
        if (resolveTransport === null) throw new Error("the transport was not determined");
        return await runDeliveriesResolve(invocation.resolve, resolveTransport, database, io);
      case "serve":
        if (webConfig === null || emailConfig === null) {
          throw new Error("web configuration was not loaded");
        }
        return await runServe(
          config,
          { web: webConfig, email: emailConfig, contactEmail },
          database,
          io,
          deps.web ?? defaultWebDeps,
          (deps.digest ?? defaultDigestDeps).createSender,
        );
      case "access:link":
        if (publicBaseUrl === null) throw new Error("PUBLIC_BASE_URL was not loaded");
        return await runAccessLink(invocation.profileId, publicBaseUrl, database, io);
      case "access:revoke":
        return await runAccessRevoke(invocation.profileId, database, io);
      case "status": {
        if (statusConfig === null) throw new Error("status configuration was not loaded");
        const digestDeps = deps.digest ?? defaultDigestDeps;
        const alert =
          emailConfig === null || operatorEmail === null
            ? null
            : { emailConfig, to: operatorEmail, deps: digestDeps };
        return await runStatus(
          config,
          statusConfig,
          database,
          io,
          digestDeps.now,
          alert,
          deps.status ?? defaultStatusDeps,
        );
      }
      case "backup":
        return await runBackup(
          invocation.dir,
          database,
          io,
          (deps.digest ?? defaultDigestDeps).now,
        );
      case "restore":
        return await runRestore(invocation.file, database, io);
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
  // Hints only (the profile is created): on stderr, so stdout stays one JSON line.
  for (const warning of profileWarnings(input)) io.stderr(`${warning}\n`);
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

/**
 * `digest`: today's digests under the digest lock (one run at a time), as
 * one JSON summary on stdout (ids and counts only: never addresses or e-mail
 * content, also in a dry run). Exit 0 when every e-mail went out or there was
 * nothing to send, and when another run holds the lock (status `skipped`);
 * 1 when a send failed or is uncertain, the profile given is missing or
 * invalid, the lock was lost, the schema is not migrated or the database is
 * unavailable.
 */
async function runDigestCommand(
  config: AppConfig,
  emailConfig: EmailConfig,
  args: DigestArgs,
  database: CliDatabase,
  io: CliIo,
  digestDeps: CliDigestDeps,
  publicBaseUrl: string | null,
): Promise<ExitCode> {
  if (database.withDigestLock === undefined || database.pendingMigrations === undefined) {
    throw new Error("database cannot run digest");
  }
  const logger = createLogger(config.logLevel, io.stderr);
  const sender = args.dryRun ? null : digestDeps.createSender(emailConfig);
  let locked: LockResult<DigestSummary>;
  try {
    const pending = await database.pendingMigrations();
    if (pending.length > 0) {
      io.stderr("Digest failed: the database schema is not up to date; run `migrate`.\n");
      return ExitCode.Failure;
    }
    locked = await database.withDigestLock(
      (db, signal) =>
        runDigest(
          {
            db,
            transport: emailConfig.mode,
            sender,
            now: digestDeps.now(),
            logger,
            sleep: digestDeps.sleep,
            signal,
            publicBaseUrl,
            ...(digestDeps.retryDelaysMs === undefined
              ? {}
              : { retryDelaysMs: digestDeps.retryDelaysMs }),
          },
          { profileId: args.profileId, dryRun: args.dryRun },
        ),
      logger,
    );
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Digest failed: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  } finally {
    sender?.close();
  }

  if (!locked.acquired) {
    logger.warn("digest lock busy", { lockKey: String(DIGEST_LOCK_KEY) });
    const skipped = { status: "skipped", reason: "lock_busy", dryRun: args.dryRun, profiles: [] };
    io.stdout(`${JSON.stringify(skipped)}\n`);
    io.stderr("Digest skipped: another digest run holds the lock; nothing was sent.\n");
    return ExitCode.Ok;
  }
  const summary = locked.value;
  const failed = locked.lockLost || digestFailed(summary);
  io.stdout(`${JSON.stringify({ status: failed ? "failed" : "ok", ...summary })}\n`);
  // Rows left pending (an uncertain send, a crashed run) are never resent: say so on every run.
  const pending = summary.profiles.reduce((total, profile) => total + profile.uncertain, 0);
  if (pending > 0) {
    io.stderr(
      `Digest: ${String(pending)} ` +
        (pending === 1 ? "delivery is pending and needs" : "deliveries are pending and need") +
        " an operator decision (README „Wynik niepewny”).\n",
    );
  }
  if (!failed) return ExitCode.Ok;
  if (locked.lockLost) {
    io.stderr("Digest aborted: the digest lock was lost during the run (lock_lost).\n");
  }
  if (summary.errorCode !== null) {
    io.stderr(
      `Digest stopped (${summary.errorCode}): a send failed for a reason that is not about ` +
        "the message; the remaining profiles were not run.\n",
    );
  }
  const problems = summary.profiles
    .filter(profileFailed)
    .map((profile) => `${profile.profileId} (${profile.errorCode ?? profile.status})`);
  if (problems.length > 0) io.stderr(`Digest failed for: ${problems.join(", ")}\n`);
  return ExitCode.Failure;
}

/**
 * `deliveries:pending`: the pending deliveries per profile, transport and
 * digest day as one JSON line (ids, dates and counts — never addresses or
 * titles). Read-only, no lock: a running digest's claimed rows show up too
 * (`deliveries:resolve` refuses while it runs).
 */
async function runDeliveriesPending(database: CliDatabase, io: CliIo): Promise<ExitCode> {
  if (database.listPendingDeliveries === undefined) {
    throw new Error("database cannot list pending deliveries");
  }
  let pending: PendingDeliveries;
  try {
    const notReady = await schemaNotReady(database);
    if (notReady !== null) {
      io.stderr(`Cannot list pending deliveries: ${notReady}.\n`);
      return ExitCode.Failure;
    }
    pending = await database.listPendingDeliveries();
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Cannot list pending deliveries: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }
  io.stdout(
    `${JSON.stringify({ status: "ok", pending: pending.groups, truncated: pending.truncated })}\n`,
  );
  return ExitCode.Ok;
}

/**
 * `feedback:report` (PR-12, D-032): the ratings counted in total, per profile
 * and per category, with the coverage of the offers sent, as one JSON line
 * (ids, categories and counts — never addresses or titles). Read-only, no lock.
 */
async function runFeedbackReport(
  since: string | null,
  database: CliDatabase,
  io: CliIo,
): Promise<ExitCode> {
  if (database.countFeedback === undefined) throw new Error("database cannot count feedback");
  let counts: FeedbackCounts;
  try {
    const notReady = await schemaNotReady(database);
    if (notReady !== null) {
      io.stderr(`Cannot report feedback: ${notReady}.\n`);
      return ExitCode.Failure;
    }
    counts = await database.countFeedback(since);
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Cannot report feedback: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }
  io.stdout(`${JSON.stringify({ status: "ok", ...buildFeedbackReport(counts, since) })}\n`);
  return ExitCode.Ok;
}

/**
 * `deliveries:resolve`: the operator's decision on the profile's pending
 * deliveries of one transport (README „Wynik niepewny”, D-024), in one
 * transaction under the digest lock. Exit 1, nothing changed, while a digest
 * or another deliveries:resolve runs or when no pending row matches. Prints
 * the transport and the number of rows changed as one JSON line.
 */
async function runDeliveriesResolve(
  args: ResolveArgs,
  transport: DeliveryTransport,
  database: CliDatabase,
  io: CliIo,
): Promise<ExitCode> {
  if (database.resolvePendingDeliveries === undefined) {
    throw new Error("database cannot resolve deliveries");
  }
  let result: ResolveResult;
  try {
    const notReady = await schemaNotReady(database);
    if (notReady !== null) {
      io.stderr(`Deliveries not resolved: ${notReady}.\n`);
      return ExitCode.Failure;
    }
    result = await database.resolvePendingDeliveries({
      profileId: args.profileId,
      transport,
      digestDate: args.digestDate,
      outcome: args.outcome,
    });
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Deliveries not resolved: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }
  if (result.status === "lock_busy") {
    io.stderr(
      "Deliveries not resolved: a digest run or another deliveries:resolve holds the lock " +
        "(a digest's claimed rows are pending until it ends); nothing was changed. " +
        "Try again when it has finished.\n",
    );
    return ExitCode.Failure;
  }
  if (result.changed === 0) {
    // Names the transport: rows of the other one may still be pending (e.g.
    // after EMAIL_MODE changed), and "no pending deliveries" alone would be false.
    io.stderr(
      args.digestDate === null
        ? `Deliveries not resolved: the profile has no pending deliveries over transport ` +
            `"${transport}"; nothing was changed.\n`
        : `Deliveries not resolved: the profile has no pending deliveries of that day over ` +
            `transport "${transport}"; nothing was changed.\n`,
    );
    return ExitCode.Failure;
  }
  io.stdout(
    `${JSON.stringify({
      status: "ok",
      outcome: args.outcome,
      transport,
      digestDate: args.digestDate,
      changed: result.changed,
    })}\n`,
  );
  return ExitCode.Ok;
}

/** The schema check `serve`, `access:link` and `access:revoke` share; a message when not ready, else null. */
async function schemaNotReady(database: CliDatabase): Promise<string | null> {
  if (database.pendingMigrations === undefined) throw new Error("database cannot check migrations");
  const pending = await database.pendingMigrations();
  return pending.length > 0 ? "the database schema is not up to date; run `migrate`" : null;
}

/** A listen failure's errno code (EADDRINUSE, EACCES, ...), validated; else null. */
function listenErrorCode(error: unknown): string | null {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : null;
}

/** What `serve` reads from the environment besides AppConfig. */
interface ServeConfig {
  readonly web: WebConfig;
  /** The transport of the access e-mails (D-031), the same as `digest`'s. */
  readonly email: EmailConfig;
  readonly contactEmail: string | null;
}

/**
 * `serve`: the web server (src/web) until SIGINT/SIGTERM, then a graceful
 * shutdown (open requests finish, bounded) and exit 0. Exit 1 when the
 * schema is not up to date, the database is unavailable or the address
 * cannot be bound. Logs one line per request (method, route name, status,
 * duration) on stderr; never a URL, token, cookie or address. The access
 * e-mails (D-031) go over the configured transport (EMAIL_MODE=test: the
 * outbox); the sender is closed after the server, which waits for the
 * e-mail being sent.
 */
async function runServe(
  config: AppConfig,
  serveConfig: ServeConfig,
  database: CliDatabase,
  io: CliIo,
  webDeps: CliWebDeps,
  createSender: (config: EmailConfig) => EmailSender,
): Promise<ExitCode> {
  const webConfig = serveConfig.web;
  if (database.startWebServer === undefined) throw new Error("database cannot serve");
  const logger = createLogger(config.logLevel, io.stderr);
  try {
    const notReady = await schemaNotReady(database);
    if (notReady !== null) {
      io.stderr(`Serve failed: ${notReady}.\n`);
      return ExitCode.Failure;
    }
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Serve failed: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }
  // Registered before listening, so a signal during startup is not lost.
  const shutdown = webDeps.waitForShutdown();
  const sender = createSender(serveConfig.email);
  try {
    let server: WebServer;
    try {
      server = await database.startWebServer({
        host: webConfig.host,
        port: webConfig.port,
        publicBaseUrl: webConfig.publicBaseUrl,
        logger,
        sender,
        contactEmail: serveConfig.contactEmail,
      });
    } catch (error: unknown) {
      const code = listenErrorCode(error);
      if (code === null) throw error;
      io.stderr(`Serve failed: cannot listen on WEB_HOST:WEB_PORT (${code}).\n`);
      return ExitCode.Failure;
    }
    logger.info("web server listening", { host: server.host, port: server.port });
    await shutdown;
    logger.info("web server stopping");
    await server.close();
    logger.info("web server stopped");
    return ExitCode.Ok;
  } finally {
    sender.close();
  }
}

/**
 * `access:link`: a new single-use login link (7 days) for the profile, as
 * one JSON line on stdout. The link is a secret: printed for the operator to
 * hand over, never logged.
 */
async function runAccessLink(
  profileId: string,
  publicBaseUrl: string,
  database: CliDatabase,
  io: CliIo,
): Promise<ExitCode> {
  if (database.issueLoginToken === undefined) throw new Error("database cannot issue links");
  let issued: IssuedToken | null;
  try {
    const notReady = await schemaNotReady(database);
    if (notReady !== null) {
      io.stderr(`Link not created: ${notReady}.\n`);
      return ExitCode.Failure;
    }
    issued = await database.issueLoginToken(profileId);
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Link not created: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }
  if (issued === null) {
    io.stderr("Profile not found.\n");
    return ExitCode.Failure;
  }
  io.stdout(
    `${JSON.stringify({
      status: "ok",
      url: loginUrl(publicBaseUrl, issued.token),
      expiresAt: issued.expiresAt.toISOString(),
    })}\n`,
  );
  io.stderr(
    "The link is a secret: whoever opens it gets into the profile. It works once, " +
      "for 7 days; hand it over only to the profile's owner.\n",
  );
  return ExitCode.Ok;
}

/**
 * `access:revoke`: deletes every token and session of the profile (one
 * transaction) and prints the counts as one JSON line. Never prints or logs
 * a token, hash or address; the profile itself is left as it is.
 */
async function runAccessRevoke(
  profileId: string,
  database: CliDatabase,
  io: CliIo,
): Promise<ExitCode> {
  if (database.revokeProfileAccess === undefined) throw new Error("database cannot revoke access");
  let revoked: RevokedAccess | null;
  try {
    const notReady = await schemaNotReady(database);
    if (notReady !== null) {
      io.stderr(`Access not revoked: ${notReady}.\n`);
      return ExitCode.Failure;
    }
    revoked = await database.revokeProfileAccess(profileId);
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") throw error;
    io.stderr(`Access not revoked: database ${formatDatabaseFailure(failure)}\n`);
    return ExitCode.Failure;
  }
  if (revoked === null) {
    io.stderr("Profile not found.\n");
    return ExitCode.Failure;
  }
  io.stdout(
    `${JSON.stringify({ status: "ok", tokens: revoked.tokens, sessions: revoked.sessions })}\n`,
  );
  return ExitCode.Ok;
}

/** Where and how `status --notify` sends its alert. */
interface OperatorAlert {
  readonly emailConfig: EmailConfig;
  readonly to: string;
  readonly deps: CliDigestDeps;
}

/**
 * One plain-text e-mail to the operator over the configured transport
 * (EMAIL_MODE=test: the outbox), with the in-run retries of `digest`.
 */
async function sendOperatorAlert(report: StatusReport, alert: OperatorAlert): Promise<SendResult> {
  const sender = alert.deps.createSender(alert.emailConfig);
  try {
    const { subject, text } = formatOperatorAlert(report);
    return await sendWithRetry(
      sender,
      { to: alert.to, subject, text, listUnsubscribe: false },
      {
        sleep: alert.deps.sleep,
        // Nothing aborts it: every send is bounded by the transport's own timeouts.
        signal: new AbortController().signal,
        ...(alert.deps.retryDelaysMs === undefined ? {} : { delaysMs: alert.deps.retryDelaysMs }),
      },
    );
  } finally {
    sender.close();
  }
}

/**
 * With `--notify`, an unexpected error of `status` (a bug) is alerted too, so
 * a cron job that keeps failing is not silent: the fixed code
 * `status_internal_error` only — the error's text may carry configuration.
 * A failing alert is reported by its code and never hides the error.
 */
async function alertInternalError(checkedAt: Date, alert: OperatorAlert, io: CliIo): Promise<void> {
  try {
    const result = await sendOperatorAlert(
      failedStatus(checkedAt, "status_internal_error", null),
      alert,
    );
    if (!result.ok) io.stderr(`Operator alert not sent (${result.error.code}).\n`);
  } catch {
    io.stderr("Operator alert not sent.\n");
  }
}

/**
 * `status [--notify]`: the operator's report as one JSON line on stdout
 * (ids, statuses, codes, timestamps and counts; src/operations/status.ts).
 * Read-only, takes no lock. Exit 0 when there is no problem; 1 when there is
 * one — including a database that cannot be read or a schema that is not
 * migrated, which are reported (and alerted) like any other problem — or
 * when the alert could not be sent. With `--notify` and a problem, one alert
 * goes to OPERATOR_EMAIL; it is sent again by every run while the problem
 * lasts.
 *
 * With BACKUP_DIR the age of the newest backup is checked too (also when the
 * database cannot be read). With HEARTBEAT_URL a run that exits 0 then pings
 * it once, with or without `--notify`: the dead man's switch alerts when the
 * pings stop (D-029). A failed ping keeps exit 0 — the system is fine, the
 * missing ping alerts anyway — and is logged as `heartbeat_failed` with a
 * fixed reason; the URL is never printed or logged.
 */
async function runStatus(
  config: AppConfig,
  statusConfig: StatusConfig,
  database: CliDatabase,
  io: CliIo,
  now: () => Date,
  alert: OperatorAlert | null,
  statusDeps: CliStatusDeps,
): Promise<ExitCode> {
  if (database.collectStatus === undefined || database.pendingMigrations === undefined) {
    throw new Error("database cannot report status");
  }
  const logger = createLogger(config.logLevel, io.stderr);
  const checkedAt = now();
  let report: StatusReport;
  try {
    const pending = await database.pendingMigrations();
    report =
      pending.length > 0
        ? failedStatus(checkedAt, "schema_not_ready", null)
        : await database.collectStatus(checkedAt);
  } catch (error: unknown) {
    const failure = describeDatabaseFailure(error);
    if (failure.reason === "unknown") {
      if (alert !== null) await alertInternalError(checkedAt, alert, io);
      // Still the fixed internal message and exit 1 (runCli), whatever the alert did.
      throw error;
    }
    report = failedStatus(checkedAt, "database_unavailable", failure);
  }
  if (statusConfig.backupDir !== null) {
    report = withBackupCheck(report, await readBackupDirectory(statusConfig.backupDir, checkedAt));
  }

  let notification: "sent" | "failed" | "not_needed" | null = null;
  let sendError: string | null = null;
  if (alert !== null) {
    if (report.status === "ok") {
      notification = "not_needed";
    } else {
      const result = await sendOperatorAlert(report, alert);
      notification = result.ok ? "sent" : "failed";
      sendError = result.ok ? null : result.error.code;
    }
  }
  const exitCode =
    report.status === "ok" && notification !== "failed" ? ExitCode.Ok : ExitCode.Failure;

  // Only a run that exits 0 pings: a missing ping is the alert.
  let heartbeat: "sent" | "failed" | "disabled" | "skipped" = "disabled";
  let heartbeatError: string | null = null;
  if (statusConfig.heartbeatUrl !== null) {
    if (exitCode !== ExitCode.Ok) {
      heartbeat = "skipped";
    } else {
      const result = await statusDeps.ping(statusConfig.heartbeatUrl);
      heartbeat = result.ok ? "sent" : "failed";
      heartbeatError = result.ok ? null : result.reason;
    }
  }

  io.stdout(
    `${JSON.stringify({ ...report, backup: report.backup ?? null, notification, heartbeat })}\n`,
  );
  logger.info("status checked", {
    status: report.status,
    problems: report.problems.length,
    notification,
    heartbeat,
    ...(sendError === null ? {} : { errorCode: sendError }),
  });
  if (heartbeatError !== null) {
    logger.warn("heartbeat failed", { errorCode: "heartbeat_failed", reason: heartbeatError });
  }
  if (report.status === "problem") {
    io.stderr(`Status: problem (${report.problems.join(", ")}); see docs/RUNBOOK.md.\n`);
  }
  if (sendError !== null) io.stderr(`Operator alert not sent (${sendError}).\n`);
  if (heartbeatError !== null) io.stderr(`Heartbeat ping failed (${heartbeatError}).\n`);
  return exitCode;
}

const BACKUP_FAILURE_TEXT: Readonly<Record<BackupFailureReason, string>> = {
  unsupported_database_url:
    "a connection setting the PostgreSQL tools cannot be given the same way (all of them must be in DATABASE_URL, with no PG* variable set)",
  invalid_schema: "the schema of DATABASE_URL does not exist or has an unsupported name",
  nothing_to_back_up: "the schema has no tables (run `migrate` first)",
  target_not_empty: "the target schema is not empty; restore only into an empty schema",
  not_a_directory: "the directory does not exist",
  not_a_file: "the backup file does not exist or is not a regular file",
  file_exists: "a backup with the same name already exists",
  write_failed: "the backup file cannot be written",
  tool_not_found: "pg_dump/pg_restore not found on PATH (PostgreSQL 16 client or newer)",
  version_mismatch: "pg_dump/pg_restore is older than the server or the backup file",
  authentication_failed: "the database refused the login",
  unreachable: "the database cannot be reached",
  timeout: "the time limit was exceeded; the tool was stopped",
  tool_failed: "the tool failed",
  nothing_restored: "the backup holds no tables of this schema",
};

/** A fixed message for a backup/restore failure; null for anything else (a bug). */
function backupFailure(error: unknown): string | null {
  if (error instanceof BackupError) {
    const text = BACKUP_FAILURE_TEXT[error.reason];
    return `${text} (${error.reason}${error.detail === null ? "" : `, ${error.detail}`})`;
  }
  const failure = describeDatabaseFailure(error);
  return failure.reason === "unknown" ? null : `database ${formatDatabaseFailure(failure)}`;
}

/**
 * `backup <dir>`: pg_dump of the application's schema into a new owner-only
 * file (src/operations/backup.ts); prints its path and size as one JSON line.
 */
async function runBackup(
  dir: string,
  database: CliDatabase,
  io: CliIo,
  now: () => Date,
): Promise<ExitCode> {
  if (database.backup === undefined) throw new Error("database cannot back up");
  const started = performance.now();
  let result: BackupResult;
  try {
    result = await database.backup(dir, now(), { env: io.env });
  } catch (error: unknown) {
    const why = backupFailure(error);
    if (why === null) throw error;
    io.stderr(`Backup failed: ${why}.\n`);
    return ExitCode.Failure;
  }
  io.stdout(
    `${JSON.stringify({
      status: "ok",
      ...result,
      durationMs: Math.round(performance.now() - started),
    })}\n`,
  );
  io.stderr("The backup holds personal data: keep it owner-only and encrypted off this host.\n");
  return ExitCode.Ok;
}

/**
 * `restore <file>`: pg_restore into the empty schema of DATABASE_URL, then
 * the readiness check and the row counts per table, as one JSON line.
 */
async function runRestore(file: string, database: CliDatabase, io: CliIo): Promise<ExitCode> {
  if (database.restore === undefined) throw new Error("database cannot restore");
  const started = performance.now();
  let result: RestoreResult;
  try {
    result = await database.restore(file, { env: io.env });
  } catch (error: unknown) {
    const why = backupFailure(error);
    if (why === null) throw error;
    io.stderr(`Restore failed: ${why}.\n`);
    return ExitCode.Failure;
  }
  const ready = result.pendingMigrations.length === 0;
  io.stdout(
    `${JSON.stringify({
      status: ready ? "ok" : "not_migrated",
      schema: result.schema,
      tables: result.tables,
      pendingMigrations: result.pendingMigrations,
      durationMs: Math.round(performance.now() - started),
    })}\n`,
  );
  if (!ready) {
    io.stderr("Restored, but the database schema is not up to date; run `migrate`.\n");
    return ExitCode.Failure;
  }
  return ExitCode.Ok;
}

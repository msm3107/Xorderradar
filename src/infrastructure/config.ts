import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * `postgres://` or `postgresql://` connection URL. The value usually contains a
 * password, so it is only checked here and never included in any message.
 */
const databaseUrlSchema = z.string().refine((value) => {
  const url = URL.parse(value);
  return url !== null && (url.protocol === "postgres:" || url.protocol === "postgresql:");
});

/**
 * Public contact of the operator, put into the crawler User-Agent so source
 * owners can reach us: an e-mail address or an `https:` URL without
 * credentials. Restricted to printable ASCII without `(`, `)`, `"` and `\`, so it
 * can be embedded verbatim in the User-Agent comment.
 */
export const crawlerContactSchema = z
  .string()
  .max(200)
  .refine((value) => {
    if (!/^[\x21-\x7e]+$/.test(value) || /[()"\\]/.test(value)) return false;
    if (z.email().safeParse(value).success) return true;
    const url = URL.parse(value);
    return (
      url !== null &&
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === ""
    );
  });

/**
 * Runtime configuration parsed from environment variables.
 *
 * Only variables actually used by the code belong here. Later PRs add their own
 * together with the code that reads them.
 */
const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DATABASE_URL: databaseUrlSchema,
    // Optional here so `health`/`migrate` work without it; commands that fetch
    // from sources must pass it to SafeHttpClient, which refuses to start without it.
    CRAWLER_CONTACT: crawlerContactSchema.optional(),
  })
  // Unknown variables are ignored on purpose: process.env always contains many
  // unrelated entries (PATH, HOME, ...), so .strict() would be meaningless here.
  .transform((env) => ({
    environment: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    crawlerContact: env.CRAWLER_CONTACT ?? null,
  }));

export type AppConfig = z.output<typeof configSchema>;
export type LogLevel = AppConfig["logLevel"];

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Parses configuration from an environment map. Throws ConfigError listing the
 * offending variable names only — never their values, which may be secrets.
 *
 * An empty value (`LOG_LEVEL=` in a .env file or the shell) counts as unset, so
 * the default applies instead of a validation error.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const nonEmpty = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = configSchema.safeParse(nonEmpty);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new ConfigError(`Invalid environment configuration: ${names.join(", ")}`);
  }
  return result.data;
}

/** How `digest` delivers e-mails (D-010): `test` writes files only, `smtp` really sends. */
export const emailModes = ["test", "smtp"] as const;
export type EmailMode = (typeof emailModes)[number];

/** Outbox of the `test` mode, relative to the working directory (git-ignored). */
export const DEFAULT_EMAIL_OUTBOX_DIR = "./outbox";

/** Sender of `test`-mode messages when EMAIL_FROM is unset: a reserved, never-deliverable domain. */
export const TEST_EMAIL_FROM = {
  name: "Radar Zamówień",
  address: "radar@example.invalid",
} as const;

export interface EmailAddress {
  readonly name: string;
  readonly address: string;
}

/**
 * EMAIL_FROM: `radar@example.com` or `Radar Zamówień <radar@example.com>`.
 * The display name may not contain quotes, angle brackets, backslashes or
 * control characters, so no header can be smuggled in; nodemailer encodes it.
 */
const emailFromSchema = z
  .string()
  .max(200)
  .transform((value, context): EmailAddress => {
    const named = /^([^"<>\\\p{Cc}]{1,100}?) *<([^<>\s]+)>$/u.exec(value);
    const name = named?.[1]?.trim() ?? "";
    const address = named?.[2] ?? value;
    if (!z.email().safeParse(address).success) {
      context.addIssue({ code: "custom", message: "not an e-mail address" });
      return z.NEVER;
    }
    return { name, address };
  });

/** The SMTP server as `digest` uses it (never logged: it may carry a password). */
export interface SmtpServer {
  readonly host: string;
  /** null: the protocol's default (465 for smtps, 587 for smtp). */
  readonly port: number | null;
  /** smtps: TLS from the first byte; smtp: STARTTLS, required (no plaintext fallback). */
  readonly implicitTls: boolean;
  readonly user: string | null;
  readonly password: string | null;
}

/**
 * SMTP_URL: `smtps://user:password@host[:port]` (implicit TLS) or
 * `smtp://user:password@host[:port]` (STARTTLS required). Credentials are
 * optional but come in pairs. No path, query or fragment: nodemailer would
 * read options (e.g. switching certificate checks off) from the query.
 */
const smtpUrlSchema = z.string().transform((value, context): SmtpServer => {
  const url = URL.parse(value);
  const valid =
    url !== null &&
    (url.protocol === "smtps:" || url.protocol === "smtp:") &&
    url.hostname !== "" &&
    (url.pathname === "" || url.pathname === "/") &&
    url.search === "" &&
    url.hash === "" &&
    (url.username === "") === (url.password === "");
  if (!valid) {
    context.addIssue({ code: "custom", message: "not an smtp:// or smtps:// URL" });
    return z.NEVER;
  }
  let credentials: { user: string | null; password: string | null };
  try {
    credentials = {
      user: url.username === "" ? null : decodeURIComponent(url.username),
      password: url.password === "" ? null : decodeURIComponent(url.password),
    };
  } catch {
    context.addIssue({ code: "custom", message: "invalid percent-encoding" });
    return z.NEVER;
  }
  const { user, password } = credentials;
  return {
    // URL keeps IPv6 literals in brackets; the socket needs the bare address.
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? null : Number(url.port),
    implicitTls: url.protocol === "smtps:",
    user,
    password,
  };
});

const emailModeSchema = z.enum(emailModes).default("test");

const emailEnvSchema = z
  .object({
    EMAIL_MODE: emailModeSchema,
    EMAIL_FROM: emailFromSchema.optional(),
    SMTP_URL: smtpUrlSchema.optional(),
    EMAIL_OUTBOX_DIR: z
      .string()
      .max(500)
      .refine((value) => !/\p{Cc}/u.test(value))
      .default(DEFAULT_EMAIL_OUTBOX_DIR),
  })
  .superRefine((env, context) => {
    if (env.EMAIL_MODE !== "smtp") return;
    if (env.EMAIL_FROM === undefined) {
      context.addIssue({ code: "custom", path: ["EMAIL_FROM"], message: "required for smtp" });
    }
    if (env.SMTP_URL === undefined) {
      context.addIssue({ code: "custom", path: ["SMTP_URL"], message: "required for smtp" });
    }
  });

/** The e-mail configuration of `digest` (D-010). */
export type EmailConfig =
  | { readonly mode: "test"; readonly from: EmailAddress; readonly outboxDir: string }
  | { readonly mode: "smtp"; readonly from: EmailAddress; readonly smtp: SmtpServer };

/**
 * Parses the e-mail variables (only `digest` and `status --notify` read them,
 * so the other commands work without them). `test` is the default and never
 * sends; `smtp` needs EMAIL_FROM and SMTP_URL. Like loadConfig: empty values count as unset, and
 * a ConfigError names the variables only — SMTP_URL holds a password.
 */
export function loadEmailConfig(env: Readonly<Record<string, string | undefined>>): EmailConfig {
  const nonEmpty = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = emailEnvSchema.safeParse(nonEmpty);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
    throw new ConfigError(`Invalid e-mail configuration: ${names.join(", ")}`);
  }
  const { EMAIL_MODE: mode, EMAIL_FROM: from, SMTP_URL: smtp, EMAIL_OUTBOX_DIR } = result.data;
  if (mode === "test") {
    return { mode, from: from ?? TEST_EMAIL_FROM, outboxDir: EMAIL_OUTBOX_DIR };
  }
  if (from === undefined || smtp === undefined) {
    // Unreachable: superRefine requires both for smtp.
    throw new ConfigError("Invalid e-mail configuration: EMAIL_FROM, SMTP_URL");
  }
  return { mode, from, smtp };
}

/**
 * Parses EMAIL_MODE alone, for `deliveries:resolve` (its default transport):
 * the same rule and error as loadEmailConfig, but without EMAIL_FROM and
 * SMTP_URL, which resolving never uses.
 */
export function loadEmailMode(env: Readonly<Record<string, string | undefined>>): EmailMode {
  const result = z.object({ EMAIL_MODE: emailModeSchema }).safeParse(nonEmptyEnv(env));
  if (!result.success) throw configError("Invalid e-mail configuration", result.error);
  return result.data.EMAIL_MODE;
}

/** Hosts for which PUBLIC_BASE_URL may use plain `http:` (local development only). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * PUBLIC_BASE_URL: the address users reach the web server at (through the
 * reverse proxy that terminates TLS), e.g. `https://radar.example.com`. Links
 * in e-mails and the Origin check are built from it. `https:` only; `http:`
 * only for localhost/127.0.0.1/[::1] outside production. No credentials,
 * path, query or fragment: the session cookie is `__Host-` (Path=/), so the
 * application lives at the root. Normalized to the origin.
 */
function publicBaseUrlSchema(environment: string | undefined) {
  return z.string().transform((value, context): string => {
    const url = URL.parse(value);
    const valid =
      url !== null &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          LOOPBACK_HOSTS.has(url.hostname) &&
          environment !== "production")) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      // URL.parse accepts e.g. "https://a b"; the raw value must already be clean.
      !/[\s\p{Cc}]/u.test(value);
    if (!valid) {
      context.addIssue({ code: "custom", message: "not an https:// origin" });
      return z.NEVER;
    }
    return url.origin;
  });
}

/** Defaults of the `serve` listener: loopback only; the reverse proxy forwards to it. */
export const DEFAULT_WEB_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 3000;

/** The configuration of `serve` (PR-06A, D-025). */
export interface WebConfig {
  /** Interface to listen on: an IP address or `localhost`. */
  readonly host: string;
  readonly port: number;
  /** PUBLIC_BASE_URL as an origin, e.g. `https://radar.example.com`. */
  readonly publicBaseUrl: string;
}

function webEnvSchema(environment: string | undefined) {
  return z.object({
    WEB_HOST: z
      .string()
      .refine((value) => value === "localhost" || isIP(value) !== 0)
      .default(DEFAULT_WEB_HOST),
    WEB_PORT: z
      .string()
      .regex(/^[1-9]\d{0,4}$/)
      .transform(Number)
      .refine((port) => port <= 65_535)
      .optional(),
    PUBLIC_BASE_URL: publicBaseUrlSchema(environment),
  });
}

function nonEmptyEnv(env: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}

function configError(prefix: string, error: z.ZodError): ConfigError {
  const names = [...new Set(error.issues.map((issue) => issue.path.join(".")))];
  return new ConfigError(`${prefix}: ${names.join(", ")}`);
}

/**
 * Parses the variables of `serve`: PUBLIC_BASE_URL is required, WEB_HOST and
 * WEB_PORT default to 127.0.0.1:3000. Like loadConfig: empty values count as
 * unset and a ConfigError names the variables only.
 */
export function loadWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  const values = nonEmptyEnv(env);
  const result = webEnvSchema(values.NODE_ENV).safeParse(values);
  if (!result.success) throw configError("Invalid web configuration", result.error);
  return {
    host: result.data.WEB_HOST,
    port: result.data.WEB_PORT ?? DEFAULT_WEB_PORT,
    publicBaseUrl: result.data.PUBLIC_BASE_URL,
  };
}

/**
 * PUBLIC_BASE_URL for the commands that only build links (`digest`,
 * `access:link`): null when unset — `digest` then sends no web links and
 * keeps the mailto-only List-Unsubscribe; invalid → ConfigError.
 */
export function loadPublicBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const values = nonEmptyEnv(env);
  const result = z
    .object({ PUBLIC_BASE_URL: publicBaseUrlSchema(values.NODE_ENV).optional() })
    .safeParse(values);
  if (!result.success) throw configError("Invalid web configuration", result.error);
  return result.data.PUBLIC_BASE_URL ?? null;
}

/**
 * OPERATOR_EMAIL: where `status --notify` sends its alert (PR-07A, D-028); one
 * plain address. Null when unset (only `status --notify` requires it).
 * Invalid → ConfigError naming the variable only.
 */
export function loadOperatorEmail(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const result = z
    .object({ OPERATOR_EMAIL: z.email().max(254).optional() })
    .safeParse(nonEmptyEnv(env));
  if (!result.success) throw configError("Invalid e-mail configuration", result.error);
  return result.data.OPERATOR_EMAIL ?? null;
}

/**
 * CONTACT_EMAIL (PR-10): the operator's address, shown as given on the home
 * page (to whoever wants a profile), on the 409 „address taken” and the 429
 * „too many link requests” pages, and named in the notice e-mail to the old
 * address of an address change (D-031). Null when unset: none of them names
 * an address. Invalid → ConfigError naming the variable only.
 */
export function loadContactEmail(env: Readonly<Record<string, string | undefined>>): string | null {
  const result = z
    .object({ CONTACT_EMAIL: z.email().max(254).optional() })
    .safeParse(nonEmptyEnv(env));
  if (!result.success) throw configError("Invalid e-mail configuration", result.error);
  return result.data.CONTACT_EMAIL ?? null;
}

/** The optional checks of `status` (PR-07B, D-029). */
export interface StatusConfig {
  /** BACKUP_DIR: where `backup` writes (absolute); null = no backup check. */
  readonly backupDir: string | null;
  /**
   * HEARTBEAT_URL: pinged after a `status` without a problem; null = no ping.
   * A secret (heartbeat services put a token in the path): never printed or logged.
   */
  readonly heartbeatUrl: string | null;
}

/**
 * BACKUP_DIR: an absolute path (cron and systemd run from a fixed working
 * directory, but the backup directory must not depend on it), without
 * control characters.
 */
const backupDirSchema = z
  .string()
  .max(500)
  .refine((value) => isAbsolute(value) && !/\p{Cc}/u.test(value));

/**
 * HEARTBEAT_URL: an `https:` URL with a host, without credentials or a
 * fragment; path and query are kept (they usually carry the check's token).
 * The raw value must already be clean (URL.parse would drop whitespace).
 */
const heartbeatUrlSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.protocol === "https:" &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      !/[\s\p{Cc}]/u.test(value)
    );
  });

/**
 * Parses BACKUP_DIR and HEARTBEAT_URL (only `status` reads them; both
 * optional). Like loadConfig: empty values count as unset, and a ConfigError
 * names the variables only — HEARTBEAT_URL is a secret.
 */
export function loadStatusConfig(env: Readonly<Record<string, string | undefined>>): StatusConfig {
  const result = z
    .object({
      BACKUP_DIR: backupDirSchema.optional(),
      HEARTBEAT_URL: heartbeatUrlSchema.optional(),
    })
    .safeParse(nonEmptyEnv(env));
  if (!result.success) throw configError("Invalid status configuration", result.error);
  return {
    backupDir: result.data.BACKUP_DIR ?? null,
    heartbeatUrl: result.data.HEARTBEAT_URL ?? null,
  };
}

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

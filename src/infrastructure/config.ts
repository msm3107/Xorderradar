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
  })
  // Unknown variables are ignored on purpose: process.env always contains many
  // unrelated entries (PATH, HOME, ...), so .strict() would be meaningless here.
  .transform((env) => ({
    environment: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
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

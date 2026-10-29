import { checkHealth } from "./health.js";
import { ConfigError, loadConfig } from "./infrastructure/config.js";

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Exit codes follow the usual convention: 0 ok, 1 runtime/config failure, 2 usage error. */
export const ExitCode = { Ok: 0, Failure: 1, Usage: 2 } as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const usage = `Usage: radar-zamowien <command>

Commands:
  health    Print a JSON health report and exit 0 when the app is operational.
`;

/**
 * Single entry point for every operational command (later: ingest, digest).
 * Kept free of process globals so it can be tested directly.
 *
 * Order matters: the command and its arguments are validated first, so a usage
 * error always exits 2 even when the configuration is also invalid; only a valid
 * invocation loads the configuration (exit 1 on failure).
 */
export function runCli(args: readonly string[], io: CliIo): ExitCode {
  const [command, ...rest] = args;

  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(usage);
    return command === undefined ? ExitCode.Usage : ExitCode.Ok;
  }

  if (command !== "health") {
    io.stderr(`Unknown command: ${JSON.stringify(command)}\n\n${usage}`);
    return ExitCode.Usage;
  }
  if (rest.length > 0) {
    io.stderr(`Command "health" takes no arguments.\n\n${usage}`);
    return ExitCode.Usage;
  }

  let config;
  try {
    config = loadConfig(io.env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      io.stderr(`${error.message}\n`);
      return ExitCode.Failure;
    }
    throw error;
  }

  io.stdout(`${JSON.stringify(checkHealth(config))}\n`);
  return ExitCode.Ok;
}

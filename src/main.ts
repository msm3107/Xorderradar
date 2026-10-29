import { defaultCliDeps, runCli } from "./cli.js";

// Process boundary: the only place that touches process globals. runCli never
// rejects (unexpected errors become exit 1 with a fixed message), so there is no
// path where Node prints an error object that could contain configuration.
process.exitCode = await runCli(
  process.argv.slice(2),
  {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  defaultCliDeps,
);

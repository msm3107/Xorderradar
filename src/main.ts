import { runCli } from "./cli.js";

// Process boundary: the only place that touches process globals.
process.exitCode = runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

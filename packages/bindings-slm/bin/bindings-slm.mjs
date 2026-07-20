#!/usr/bin/env node
/**
 * `bindings-slm` CLI — certify --profile desktop (and future adapters).
 */
import { runBindingsSlmCli } from "../dist/certify.js";

const code = await runBindingsSlmCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exitCode = code;

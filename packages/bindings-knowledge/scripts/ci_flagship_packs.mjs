#!/usr/bin/env node
/**
 * CI: validate flagship knowledge packs + domains/ fingerprint freshness.
 * Use --prove for red→green (stale + uncited) proof.
 */
import { runFlagshipPacksCiGateCli } from "../dist/pack_ci_gate.js";

const code = runFlagshipPacksCiGateCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);

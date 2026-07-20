#!/usr/bin/env node
/**
 * Mix policy lint prove.
 * Golden manifests lint green; seeded RET / repair violations stay red.
 */
import { runProveMixPolicyLintCli } from "../dist/mix_policy.js";

const code = runProveMixPolicyLintCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);

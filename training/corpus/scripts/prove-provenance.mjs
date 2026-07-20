#!/usr/bin/env node
/**
 * Provenance audit prove.
 * Accepted ledger loads; unknown-license excluded; consent mix blocked;
 * ledger hash stable across rebuild.
 */
import { runProveProvenanceAuditCli } from "../dist/license_ledger.js";

const code = runProveProvenanceAuditCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exit(code);

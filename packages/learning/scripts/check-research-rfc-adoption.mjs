/**
 * CI gate: research-intake adoption checklist + orphan trainer-flag lint.
 *
 * Usage:
 *   pnpm --filter @moolam/learning research-rfc-adoption:check
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { proveResearchIntakeAdoptionChecklist } from "../dist/research_intake_adoption.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const result = await proveResearchIntakeAdoptionChecklist({
  repoRoot: REPO_ROOT,
  deviceId: "ci-research-rfc-adoption",
  onTelemetry: (e) => {
    process.stdout.write(`${JSON.stringify(e)}\n`);
  },
});

if (!result.ok) {
  process.stderr.write(
    `research-intake adoption prove failed\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    event: "learning.research_intake.ci",
    outcome: "ok",
    subjectId: null,
    deviceId: "ci-research-rfc-adoption",
    docsCoherent: result.docsCoherent,
    greenFlagsOk: result.greenFlagsOk,
    orphanFlagsRejected: result.orphanFlagsRejected,
  })}\n`,
);

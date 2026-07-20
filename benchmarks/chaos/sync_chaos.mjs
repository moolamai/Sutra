// Sync chaos drills (compose as deployed; in-process floor when absent):
//   1) SIGKILL orchestrator mid-sync → restart → converge
//   2) Partition Redis/Postgres via docker pause → restore → converge + audits
//   3) Corrupt LangGraph checkpoint blob → clean start + advisory, no crash-loop
//   4) Post-drill invariant suite (commutativity, advisory uniqueness, no content leak)
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  orchestratorHealthy,
  runKillOrchestratorMidSyncDrill,
  runComposeKillMidSyncDrill,
  runPartitionRedisPostgresDrill,
  runComposePartitionDrill,
  runCorruptCheckpointDrill,
  runComposeCorruptCheckpointDrill,
  formatSyncChaosGateReport,
  emitSyncChaosTelemetry,
} from "../_shared/sync_chaos_probe.mjs";
import {
  runPostDrillInvariantSuite,
  formatPostDrillInvariantReport,
} from "../_shared/chaos_invariants.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const COMPOSE_FILE = path.join(REPO_ROOT, "infra/docker-compose.yml");

const ORCH_URL = process.env.SUTRA_ORCHESTRATOR_URL ?? "http://127.0.0.1:8000";
const API_KEY = process.env.SUTRA_API_KEY ?? "compose-operator-surface";
/** `all` | `kill` | `partition` | `checkpoint` | `invariants` */
const DRILL = (process.env.SUTRA_CHAOS_DRILL ?? "all").toLowerCase();

const composeUp = await orchestratorHealthy(ORCH_URL);

emitSyncChaosTelemetry({
  outcome: composeUp ? "compose" : "in_process_fallback",
  action: "start",
  drill: DRILL,
  orchestratorUrl: composeUp ? ORCH_URL : null,
  deviceId: "edge-chaos",
  subjectId: null,
});

if (!composeUp) {
  emitSyncChaosTelemetry({
    outcome: "compose_unavailable",
    action: "notice",
    detail:
      "Start infra/docker-compose for full SIGKILL/pause/corrupt drills; running in-process floor.",
    deviceId: "edge-chaos",
    subjectId: null,
  });
}

const results = [];

async function runKill() {
  return composeUp
    ? runComposeKillMidSyncDrill({
        baseUrl: ORCH_URL,
        apiKey: API_KEY,
        deviceId: "edge-chaos-kill",
        composeFile: COMPOSE_FILE,
        cwd: REPO_ROOT,
      })
    : runKillOrchestratorMidSyncDrill({ deviceId: "edge-chaos-kill" });
}

async function runPartition() {
  return composeUp
    ? runComposePartitionDrill({
        baseUrl: ORCH_URL,
        apiKey: API_KEY,
        deviceId: "edge-chaos-part",
      })
    : runPartitionRedisPostgresDrill({ deviceId: "edge-chaos-part" });
}

async function runCheckpoint() {
  return composeUp
    ? runComposeCorruptCheckpointDrill({
        baseUrl: ORCH_URL,
        apiKey: API_KEY,
        deviceId: "edge-chaos-ckpt",
      })
    : runCorruptCheckpointDrill({ deviceId: "edge-chaos-ckpt" });
}

const wantScenarios =
  DRILL === "all" ||
  DRILL === "kill" ||
  DRILL === "partition" ||
  DRILL === "checkpoint" ||
  DRILL === "corrupt" ||
  DRILL === "invariants";

if (wantScenarios) {
  if (DRILL === "all" || DRILL === "kill" || DRILL === "invariants") {
    const kill = await runKill();
    if (!kill.drill) kill.drill = "kill_orchestrator_mid_sync";
    results.push(kill);
    process.stdout.write(formatSyncChaosGateReport(kill));
  }

  if (DRILL === "all" || DRILL === "partition" || DRILL === "invariants") {
    const part = await runPartition();
    results.push(part);
    process.stdout.write(formatSyncChaosGateReport(part));
  }

  if (
    DRILL === "all" ||
    DRILL === "checkpoint" ||
    DRILL === "corrupt" ||
    DRILL === "invariants"
  ) {
    const ckpt = await runCheckpoint();
    results.push(ckpt);
    process.stdout.write(formatSyncChaosGateReport(ckpt));
  }
}

// Post-drill invariant suite — always after scenarios (or alone via invariants).
const suite = runPostDrillInvariantSuite(results, {
  deviceId: "edge-chaos-invariants",
});
process.stdout.write(formatPostDrillInvariantReport(suite));

const hardFail =
  results.some((r) => !r.skipped && !r.ok) || (!suite.ok && results.length > 0);
process.exitCode = hardFail ? 1 : 0;

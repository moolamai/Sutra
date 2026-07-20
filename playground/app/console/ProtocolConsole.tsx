"use client";

/**
 * Playground — protocol console.
 *
 * An interactive harness over the production protocol packages. Every
 * number on this screen is computed by shipped code: friction evidence
 * folding, cyclical task routing, HLC clocks, and CRDT merges via
 * `@moolam/sync-protocol`'s `CrdtHarnessResolver`. The console exists so a
 * developer can *exercise the protocol* — drive interactions on independent
 * device replicas, take them offline, diverge their state, then reconcile
 * and inspect the merge — before writing a line of integration code.
 */

import { useEffect, useMemo, useReducer, useState } from "react";
import {
  ADVANCE_THRESHOLD,
  TASK_GRAPH,
  HESITATION_SPIKE_MS,
  PROTOCOL_VERSION,
  REMEDIATE_THRESHOLD,
  applyInteraction,
  applyRouting,
  createReplica,
  evidenceCount,
  genesisState,
  masteryMean,
  mergeReplicas,
  routeTurn,
  taskGraphPackVersionStamp,
  type DeviceReplica,
  type InteractionInput,
  type CognitiveState,
} from "./engine";
import { HlcClock } from "@moolam/sync-protocol/client";

const SUBJECT_ID = "subject-demo";

interface LogEntry {
  at: string;
  kind: "interaction" | "routing" | "sync" | "system";
  lines: string[];
}

interface ConsoleState {
  replicas: DeviceReplica[];
  master: CognitiveState;
  masterClock: HlcClock;
  log: LogEntry[];
  turn: number;
}

function initialState(): ConsoleState {
  const masterClock = new HlcClock("cloud");
  return {
    replicas: [
      createReplica(SUBJECT_ID, "edge-device-a", "Device A · phi-3-mini-q4"),
      createReplica(SUBJECT_ID, "edge-device-b", "Device B · gemma-2-2b-int4"),
    ],
    master: genesisState(SUBJECT_ID, "cloud", masterClock),
    masterClock,
    log: [
      {
        // Static timestamp label: server and client renders must match (hydration).
        at: "session",
        kind: "system",
        lines: [
          `protocol v${PROTOCOL_VERSION} · two edge replicas + cloud master initialized`,
          `task-graph ${taskGraphPackVersionStamp ?? "unloaded"} · τ_advance=${ADVANCE_THRESHOLD} τ_remediate=${REMEDIATE_THRESHOLD} hesitation_spike=${HESITATION_SPIKE_MS}ms`,
        ],
      },
    ],
    turn: 0,
  };
}

function timeNow(): string {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

type Action =
  | { type: "interact"; deviceId: string; input: InteractionInput }
  | { type: "toggle-online"; deviceId: string }
  | { type: "sync"; deviceId: string }
  | { type: "reset" };

function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case "interact": {
      const replica = state.replicas.find((r) => r.deviceId === action.deviceId);
      if (!replica) return state;
      const sample = applyInteraction(replica, action.input);
      const decision = routeTurn(replica.state, sample);
      applyRouting(replica, decision);
      const entry: LogEntry = {
        at: timeNow(),
        kind: "routing",
        lines: decision.rationale.map((l) => `${replica.deviceId} · ${l}`),
      };
      return {
        ...state,
        replicas: [...state.replicas],
        turn: state.turn + 1,
        log: [entry, ...state.log].slice(0, 60),
      };
    }
    case "toggle-online": {
      const replicas = state.replicas.map((r) =>
        r.deviceId === action.deviceId ? { ...r, online: !r.online } : r,
      );
      const replica = replicas.find((r) => r.deviceId === action.deviceId)!;
      const entry: LogEntry = {
        at: timeNow(),
        kind: "system",
        lines: [
          `${replica.deviceId} → ${replica.online ? "ONLINE (sync eligible)" : "OFFLINE (edge-autonomous; friction accrues locally)"}`,
        ],
      };
      return { ...state, replicas, log: [entry, ...state.log].slice(0, 60) };
    }
    case "sync": {
      const replica = state.replicas.find((r) => r.deviceId === action.deviceId);
      if (!replica || !replica.online) return state;
      const { merged, advisories } = mergeReplicas(state.master, replica.state);
      // Edge adopts the converged master verbatim (SYNC-07 validated adoption).
      replica.state = structuredClone(merged);
      const acked = replica.pendingSamples;
      replica.pendingSamples = 0;
      const entry: LogEntry = {
        at: timeNow(),
        kind: "sync",
        lines: [
          `${replica.deviceId} ⇄ cloud · CRDT join complete · ${acked} sample(s) compacted`,
          `master frictionLog=${merged.frictionLog.length} · devices={${merged.deviceIds.join(", ")}}`,
          ...advisories.map((a) => `advisory ${a.code}: ${a.detail}`),
        ],
      };
      return {
        ...state,
        master: merged,
        replicas: [...state.replicas],
        log: [entry, ...state.log].slice(0, 60),
      };
    }
    case "reset":
      return initialState();
  }
}

export function ProtocolConsole() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [activeDevice, setActiveDevice] = useState("edge-device-a");
  const [conceptId, setConceptId] = useState("math.ratios");
  const [outcome, setOutcome] = useState<InteractionInput["outcome"]>("correct");
  const [hesitation, setHesitation] = useState(1800);
  const [revisions, setRevisions] = useState(0);
  const [assisted, setAssisted] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("sutra-playground-theme");
    if (saved === "dark" || saved === "light") setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("sutra-playground-theme", theme);
  }, [theme]);

  const replica = state.replicas.find((r) => r.deviceId === activeDevice)!;

  const divergence = useMemo(() => {
    return TASK_GRAPH.filter((c) => {
      const spread = state.replicas
        .map((r) => masteryMean(r.state, c.conceptId))
        .concat(masteryMean(state.master, c.conceptId));
      return Math.max(...spread) - Math.min(...spread) > 0.001;
    }).length;
  }, [state]);

  const submit = () =>
    dispatch({
      type: "interact",
      deviceId: activeDevice,
      input: { conceptId, outcome, hesitationMs: hesitation, revisionCount: revisions, assistanceRequested: assisted },
    });

  return (
    <main className="mx-auto max-w-[1500px] px-6 py-5">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div className="flex items-baseline gap-4">
          <h1 className="font-mono text-sm tracking-[0.25em]">SUTRA / PLAYGROUND</h1>
          <span className="hidden font-mono text-[11px] text-ink-dim sm:inline">
            hybrid cognitive sync protocol v{PROTOCOL_VERSION}
          </span>
        </div>

        <div className="flex items-center gap-4 font-mono text-[11px] text-ink-faint">
          <span>
            TURNS <span className="text-ink">{state.turn}</span>
          </span>
          <span>
            DIVERGED <span className={divergence ? "text-warn" : "text-ok"}>{divergence}</span>
          </span>
          <button
            onClick={() => dispatch({ type: "reset" })}
            className="rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:border-line-strong hover:text-ink"
          >
            RESET
          </button>
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="rounded-sm border border-line px-2 py-0.5 text-ink-dim hover:border-line-strong hover:text-ink"
            title="Toggle theme"
          >
            {theme === "light" ? "DARK" : "LIGHT"}
          </button>
        </div>
      </header>

      <div className="mt-4 grid grid-cols-12 gap-3">
        {/* ── Interaction driver ─────────────────────────────────────── */}
        <Panel title="INTERACTION DRIVER · CAST INGRESS" className="col-span-12 xl:col-span-4">
          <Field label="DEVICE REPLICA">
            <div className="flex gap-2">
              {state.replicas.map((r) => (
                <button
                  key={r.deviceId}
                  onClick={() => setActiveDevice(r.deviceId)}
                  className={`flex-1 border px-2 py-1.5 font-mono text-[11px] ${
                    activeDevice === r.deviceId
                      ? "border-accent bg-accent-soft text-ink"
                      : "border-line text-ink-dim hover:border-line-strong"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="CONCEPT UNDER EXERCISE">
            <select
              value={conceptId}
              onChange={(e) => setConceptId(e.target.value)}
              className="w-full border border-line bg-panel-2 px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
            >
              {TASK_GRAPH.map((c) => (
                <option key={c.conceptId} value={c.conceptId}>
                  {c.conceptId} — {c.title}
                </option>
              ))}
            </select>
          </Field>

          <Field label="OUTCOME">
            <div className="flex gap-2">
              {(["correct", "partial", "incorrect"] as const).map((o) => (
                <button
                  key={o}
                  onClick={() => setOutcome(o)}
                  className={`flex-1 border px-2 py-1.5 font-mono text-[11px] ${
                    outcome === o
                      ? o === "correct"
                        ? "border-ok text-ok"
                        : o === "incorrect"
                          ? "border-err text-err"
                          : "border-warn text-warn"
                      : "border-line text-ink-dim hover:border-line-strong"
                  }`}
                >
                  {o.toUpperCase()}
                </button>
              ))}
            </div>
          </Field>

          <Field label={`HESITATION ${hesitation}ms ${hesitation > HESITATION_SPIKE_MS ? "· SPIKE" : ""}`}>
            <input
              type="range"
              min={200}
              max={30000}
              step={100}
              value={hesitation}
              onChange={(e) => setHesitation(Number(e.target.value))}
              className="w-full accent-[#818cf8]"
            />
          </Field>

          <Field label={`REVISION CHURN · ${revisions} deletions`}>
            <input
              type="range"
              min={0}
              max={10}
              value={revisions}
              onChange={(e) => setRevisions(Number(e.target.value))}
              className="w-full accent-[#818cf8]"
            />
          </Field>

          <label className="mt-1 flex items-center gap-2 font-mono text-[11px] text-ink-dim">
            <input type="checkbox" checked={assisted} onChange={(e) => setAssisted(e.target.checked)} className="accent-[#818cf8]" />
            HINT REQUESTED (assistance flag)
          </label>

          <button
            onClick={submit}
            className="mt-3 w-full border border-accent bg-accent-soft py-2 font-mono text-[12px] tracking-[0.15em] text-ink hover:bg-transparent"
          >
            SUBMIT INTERACTION → ROUTE TURN
          </button>

          <div className="mt-3 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
            Evidence weighting (CAST-04): fluent correct +1.0α · non-fluent correct +0.5α ·
            incorrect +1.0β · partial +0.5α+0.5β. Fluent = hesitation &lt; 3000ms ∧ revisions ≤ 1 ∧
            no hint.
          </div>
        </Panel>

        {/* ── Mastery posteriors ─────────────────────────────────────── */}
        <Panel title="MASTERY POSTERIORS · PER REPLICA" className="col-span-12 xl:col-span-8">
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="pb-1.5 font-normal">CONCEPT</th>
                {state.replicas.map((r) => (
                  <th key={r.deviceId} className="pb-1.5 font-normal">
                    {r.deviceId.replace("edge-device-", "DEVICE ").toUpperCase()}
                  </th>
                ))}
                <th className="pb-1.5 font-normal">CLOUD MASTER</th>
              </tr>
            </thead>
            <tbody>
              {TASK_GRAPH.map((c) => (
                <tr key={c.conceptId} className="border-t border-line">
                  <td className="py-1.5 pr-3">
                    <div>{c.conceptId}</div>
                    <div className="text-[10px] text-ink-faint">
                      {c.prerequisites.length ? `requires ${c.prerequisites.join(", ")}` : "root concept"}
                    </div>
                  </td>
                  {[...state.replicas.map((r) => r.state), state.master].map((s, i) => {
                    const mean = masteryMean(s, c.conceptId);
                    const n = evidenceCount(s, c.conceptId);
                    return (
                      <td key={i} className="py-1.5 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 border border-line bg-panel-2">
                            <div
                              className={`h-full ${
                                mean >= ADVANCE_THRESHOLD ? "bg-ok" : mean >= REMEDIATE_THRESHOLD ? "bg-accent" : "bg-err"
                              }`}
                              style={{ width: `${Math.round(mean * 100)}%`, opacity: 0.7 }}
                            />
                          </div>
                          <span className="w-10">{mean.toFixed(2)}</span>
                          <span className="text-ink-faint">n={n % 1 === 0 ? n : n.toFixed(1)}</span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 border-t border-line pt-2 font-mono text-[10px] text-ink-faint">
            posterior mean of Beta(Σα+1, Σβ+1) over per-device G-Counter shards · unexercised
            concepts sit at 0.50 (maximal uncertainty, CAST-05) · thresholds: advance ≥{" "}
            {ADVANCE_THRESHOLD}, remediate &lt; {REMEDIATE_THRESHOLD}
          </p>
        </Panel>

        {/* ── Replica status & sync controls ─────────────────────────── */}
        <Panel title="REPLICA TOPOLOGY · SYNC CONTROL" className="col-span-12 xl:col-span-5">
          {state.replicas.map((r) => (
            <div key={r.deviceId} className="mb-2 border border-line bg-panel-2 p-2.5 last:mb-0">
              <div className="flex items-center justify-between font-mono text-[11px]">
                <span>{r.label}</span>
                <span className={r.online ? "text-ok" : "text-err"}>{r.online ? "ONLINE" : "OFFLINE"}</span>
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px] text-ink-dim">
                <span>
                  active <span className="text-ink">{r.state.activeConceptId ?? "—"}</span>
                </span>
                <span>
                  mode <span className="text-ink">{r.state.mode}</span>
                </span>
                <span>
                  pending samples{" "}
                  <span className={r.pendingSamples > 0 ? "text-warn" : "text-ink"}>{r.pendingSamples}</span>
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => dispatch({ type: "toggle-online", deviceId: r.deviceId })}
                  className="flex-1 border border-line py-1 font-mono text-[10px] text-ink-dim hover:border-line-strong hover:text-ink"
                >
                  {r.online ? "SIMULATE CONNECTIVITY LOSS" : "RESTORE CONNECTIVITY"}
                </button>
                <button
                  onClick={() => dispatch({ type: "sync", deviceId: r.deviceId })}
                  disabled={!r.online}
                  className={`flex-1 border py-1 font-mono text-[10px] ${
                    r.online
                      ? "border-accent bg-accent-soft text-ink hover:bg-transparent"
                      : "cursor-not-allowed border-line text-ink-faint"
                  }`}
                >
                  SYNC → CRDT JOIN WITH MASTER
                </button>
              </div>
            </div>
          ))}
          <div className="mt-2 border-t border-line pt-2 font-mono text-[10px] leading-relaxed text-ink-faint">
            Sync executes the shipped <span className="text-ink-dim">CrdtHarnessResolver.merge()</span>:
            G-Counter shards join by max (retransmission-safe), friction G-Set unions by HLC key,
            session registers resolve LWW under HLC total order. Merge is commutative, associative,
            idempotent — sync order cannot change the converged state.
          </div>
        </Panel>

        {/* ── Protocol event log ─────────────────────────────────────── */}
        <Panel title="PROTOCOL EVENT LOG" className="col-span-12 xl:col-span-7">
          <div className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
            {state.log.map((entry, i) => (
              <div key={i} className="border-l-2 pl-2.5 font-mono text-[10.5px] leading-relaxed"
                style={{
                  borderColor:
                    entry.kind === "sync" ? "var(--color-accent)" : entry.kind === "routing" ? "var(--color-line-strong)" : "var(--color-line)",
                }}
              >
                <div className="text-ink-faint">
                  {entry.at} · {entry.kind.toUpperCase()}
                </div>
                {entry.lines.map((line, j) => (
                  <div key={j} className={line.includes("SPIKE") || line.includes("advisory") ? "text-warn" : "text-ink-dim"}>
                    {line}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <footer className="mt-4 flex flex-wrap justify-between gap-2 border-t border-line pt-2 font-mono text-[10px] text-ink-faint">
        <span>MOOLAM AI · INDIAN SOVEREIGN AI INITIATIVE · OPEN COGNITIVE INFRASTRUCTURE</span>
        <span>console state is session-local · connect SUTRA_API_URL for live fleet telemetry</span>
      </footer>
    </main>
  );
}

function Panel({ title, className = "", children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-sm border border-line bg-panel p-3 ${className}`}>
      <h2 className="mb-2.5 font-mono text-[10px] tracking-[0.2em] text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 font-mono text-[10px] tracking-[0.15em] text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

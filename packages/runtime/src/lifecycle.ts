/**
 * @module lifecycle
 *
 * Runtime host - owns the lifecycle of a set of LifecycleAware components
 * (memory stores, telemetry collectors, sync engines) and guarantees
 * ordered startup, reverse-ordered shutdown, and a legal state machine.
 * The same host runs on edge and cloud; only the registered components
 * differ.
 */

import type { EventBusInterface, LifecycleAware, LifecycleState } from "@moolam/contracts";

const LEGAL_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  created: ["initializing"],
  initializing: ["ready", "failed"],
  ready: ["running", "stopped"],
  running: ["suspended", "stopped", "failed"],
  suspended: ["running", "stopped"],
  stopped: [],
  failed: [],
};

export class RuntimeHost {
  private components: Array<{ name: string; component: LifecycleAware }> = [];
  private _state: LifecycleState = "created";

  constructor(private readonly bus?: EventBusInterface) {}

  get state(): LifecycleState {
    return this._state;
  }

  /** Register a component. Startup order = registration order; shutdown is reversed. */
  register(name: string, component: LifecycleAware): this {
    if (this._state !== "created") {
      throw new Error(`cannot register '${name}' after start (state=${this._state})`);
    }
    this.components.push({ name, component });
    return this;
  }

  /** Initialize every component in order. Failure stops startup and disposes what already started. */
  async start(): Promise<void> {
    this.transition("initializing");
    const started: Array<{ name: string; component: LifecycleAware }> = [];
    try {
      for (const entry of this.components) {
        await entry.component.initialize();
        started.push(entry);
        this.emit("runtime.component-initialized", { component: entry.name });
      }
    } catch (cause) {
      // Roll back cleanly: a half-started host must not leak resources.
      for (const entry of started.reverse()) {
        await entry.component.dispose().catch(() => {});
      }
      this.transition("failed");
      throw cause;
    }
    this.transition("ready");
    this.transition("running");
  }

  /** Dispose every component in reverse order. Idempotent. */
  async stop(): Promise<void> {
    if (this._state === "stopped") return;
    for (const entry of [...this.components].reverse()) {
      await entry.component.dispose();
      this.emit("runtime.component-disposed", { component: entry.name });
    }
    this.transition("stopped");
  }

  private transition(next: LifecycleState): void {
    if (!LEGAL_TRANSITIONS[this._state].includes(next)) {
      throw new Error(`illegal lifecycle transition ${this._state} -> ${next}`);
    }
    this._state = next;
    this.emit("runtime.lifecycle", { state: next });
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.bus?.publish({ type, at: new Date().toISOString(), payload });
  }
}

/**
 * @module scheduler
 *
 * In-process task scheduler - the reference SchedulerInterface
 * implementation. Single-worker FIFO with per-task deadlines: predictable
 * on a phone, in a serverless container, and in tests. Deployments needing
 * distributed scheduling bind their own implementation to the contract.
 */

import type { RuntimeEvent, ScheduledTask, SchedulerInterface } from "@moolam/contracts";

export interface InProcessSchedulerOptions {
  /** Observer for task outcomes; defaults to a no-op. */
  onEvent?: (event: RuntimeEvent) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class InProcessScheduler implements SchedulerInterface {
  private readonly queue: ScheduledTask[] = [];
  private readonly cancelled = new Set<string>();
  private running = false;
  private readonly onEvent: (event: RuntimeEvent) => void;
  private readonly now: () => number;

  constructor(options: InProcessSchedulerOptions = {}) {
    this.onEvent = options.onEvent ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  schedule(task: ScheduledTask): void {
    // Stable insertion: equal runAtMs keeps submission order (contract rule 1).
    const index = this.queue.findIndex((t) => t.runAtMs > task.runAtMs);
    if (index === -1) this.queue.push(task);
    else this.queue.splice(index, 0, task);
    void this.drain();
  }

  cancel(taskId: string): boolean {
    const index = this.queue.findIndex((t) => t.taskId === taskId);
    if (index === -1) return false; // running or unknown: no-op per contract rule 3
    this.queue.splice(index, 1);
    this.cancelled.add(taskId);
    return true;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  /** Resolves when every currently queued task has finished or failed. */
  async idle(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue[0]!;
        const waitMs = task.runAtMs - this.now();
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue; // re-evaluate: earlier tasks may have been scheduled meanwhile
        }
        this.queue.shift();
        await this.runOne(task);
      }
    } finally {
      this.running = false;
    }
  }

  private async runOne(task: ScheduledTask): Promise<void> {
    const startedAt = this.now();
    try {
      await Promise.race([
        task.execute(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`deadline ${task.deadlineMs}ms exceeded`)), task.deadlineMs),
        ),
      ]);
      this.emit("runtime.task-completed", task, startedAt);
    } catch (cause) {
      // Contract rule 2: one failed task never blocks the queue.
      this.emit("runtime.task-failed", task, startedAt, String(cause));
    }
  }

  private emit(type: string, task: ScheduledTask, startedAt: number, error?: string): void {
    this.onEvent({
      type,
      at: new Date().toISOString(),
      payload: {
        taskId: task.taskId,
        name: task.name,
        elapsedMs: this.now() - startedAt,
        ...(error ? { error } : {}),
      },
    });
  }
}

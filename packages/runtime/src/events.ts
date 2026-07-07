/**
 * @module events
 *
 * In-process event bus - the reference EventBusInterface implementation.
 * Synchronous, at-least-once delivery with subscriber-error isolation per
 * the runtime contract: a broken observer can never break the loop that
 * emitted the event.
 */

import type { EventBusInterface, RuntimeEvent } from "@moolam/contracts";

export class InProcessEventBus implements EventBusInterface {
  private readonly handlers = new Map<string, Set<(event: RuntimeEvent) => void>>();

  /** Errors thrown by subscribers, surfaced as events instead of exceptions. */
  static readonly SUBSCRIBER_ERROR = "runtime.subscriber-error";

  publish(event: RuntimeEvent): void {
    for (const type of [event.type, "*"]) {
      for (const handler of this.handlers.get(type) ?? []) {
        try {
          handler(event);
        } catch (cause) {
          // Contract rule 1: isolation. Report through the bus itself, but
          // never recurse if the error event's own subscriber throws.
          if (event.type !== InProcessEventBus.SUBSCRIBER_ERROR) {
            this.publish({
              type: InProcessEventBus.SUBSCRIBER_ERROR,
              at: new Date().toISOString(),
              payload: { sourceType: event.type, error: String(cause) },
            });
          }
        }
      }
    }
  }

  subscribe(type: string, handler: (event: RuntimeEvent) => void): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }
}

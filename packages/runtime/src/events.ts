/**
 * @module events
 *
 * In-process event bus - the reference EventBusInterface implementation.
 * Synchronous, at-least-once delivery with subscriber-error isolation per
 * the runtime contract: a broken observer can never break the loop that
 * emitted the event.
 *
 * Domain event types and Zod payload schemas: `@moolam/observability`
 * (`event_catalog.ts`). {@link ValidatingEventBus} wraps this
 * bus with an injected catalog validator — unknown / invalid types rejected.
 *
 * Canonical JSON Schema artifacts are exported via
 * `@moolam/sync-protocol` `schemas:export` into `schemas/Event*.json`.
 *
 * Implementor reference
 * `packages/observability/docs/event-catalog.md` (linked from this package README).
 */

import type {
  EventBusInterface,
  EventBusValidationMode,
  EventPublishValidator,
  RuntimeEvent,
  ValidatingEventBusInterface,
} from "@moolam/contracts";
import {
  CATALOG_EVENT_TYPES,
  EVENT_SCHEMA_TYPE_NAMES,
  CatalogContractError,
  type CatalogEventType,
  type EventSchemaTypeName,
} from "@moolam/contracts";

export {
  CATALOG_EVENT_TYPES,
  EVENT_SCHEMA_TYPE_NAMES,
  CatalogContractError,
  type CatalogEventType,
  type EventSchemaTypeName,
  type EventBusValidationMode,
  type EventPublishValidator,
};

export class InProcessEventBus implements EventBusInterface {
  private readonly handlers = new Map<string, Set<(event: RuntimeEvent) => void>>();

  /**
   * Errors thrown by subscribers, surfaced as events instead of exceptions.
   * Cataloged as `runtime.subscriber-error` .
   */
  static readonly SUBSCRIBER_ERROR = "runtime.subscriber-error" as const satisfies CatalogEventType;

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

/**
 * EventBusInterface wrapper that validates every external `publish` against
 * an injected catalog checker (Zod schemas live in `@moolam/observability`).
 *
 * Subscriber-error isolation stays on the inner bus — isolation events are
 * not re-validated through this wrapper (inner `publish` path).
 */
export class ValidatingEventBus implements ValidatingEventBusInterface {
  private _droppedInvalidCount = 0;

  constructor(
    private readonly inner: EventBusInterface,
    private readonly validate: EventPublishValidator,
    readonly validationMode: EventBusValidationMode = "throw",
  ) {}

  get droppedInvalidCount(): number {
    return this._droppedInvalidCount;
  }

  publish(event: RuntimeEvent): void {
    const result = this.validate(event);
    if (result.ok) {
      this.inner.publish(result.event);
      return;
    }
    if (this.validationMode === "throw") {
      throw new CatalogContractError(
        result.obligation,
        event.type || "<missing>",
        result.detail,
      );
    }
    this._droppedInvalidCount += 1;
  }

  subscribe(type: string, handler: (event: RuntimeEvent) => void): () => void {
    return this.inner.subscribe(type, handler);
  }
}

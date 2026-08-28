/**
 * Domain events (Observer / Pub-Sub, report 22, 25).
 *
 * Example from the report: `APIUpdated -> invalidate cache`.
 *
 * The point is decoupling. The catalogue service should not know that a cache,
 * a search index and an analytics counter all care when an API changes; it
 * publishes a fact and subscribers react. Adding a new reaction means adding a
 * subscriber, not editing the service.
 *
 * Delivery is best-effort and in-process (plus Redis fan-out to other
 * instances when available). Anything that MUST happen goes on a durable queue
 * instead — report 23 notes the outbox pattern as the upgrade path if domain
 * events ever need transactional guarantees.
 */
import { getLogger } from '@apihub/logger';

import { getRedis } from './redis.js';

const log = getLogger('events');

/** Every domain event and its payload shape. */
export interface DomainEvents {
  'api.created': { apiId: string; slug: string };
  'api.updated': { apiId: string; slug: string; fields: string[] };
  'api.deleted': { apiId: string; slug: string };
  'api.status_changed': { apiId: string; slug: string; from: string; to: string };

  'health.checked': {
    apiId: string;
    status: string;
    previousStatus: string;
    latencyMs: number | null;
  };
  'health.incident_opened': { apiId: string; incidentId: string; errorCode: string | null };
  'health.incident_resolved': { apiId: string; incidentId: string; durationMs: number };

  'ingestion.completed': { runId: string; created: number; updated: number };
  'search.reindex_requested': { reason: string };

  'review.created': { reviewId: string; apiId: string; userId: string; rating: number };
  'review.deleted': { reviewId: string; apiId: string };

  'user.registered': { userId: string; email: string };
  'favorite.added': { userId: string; apiId: string };
  'favorite.removed': { userId: string; apiId: string };

  'playground.executed': { apiId: string | null; host: string; status: number | null };
}

export type EventName = keyof DomainEvents;
export type EventHandler<E extends EventName> = (
  payload: DomainEvents[E],
) => void | Promise<void>;

interface Subscription {
  handler: EventHandler<EventName>;
  /** Identifies the subscriber in logs when a handler throws. */
  label: string;
}

export class EventBus {
  private readonly subscribers = new Map<EventName, Subscription[]>();
  /** Set once cross-instance fan-out is wired up. */
  private redisPublish: ((channel: string, message: string) => Promise<unknown>) | null = null;

  /** Register a handler. Returns an unsubscribe function. */
  on<E extends EventName>(event: E, handler: EventHandler<E>, label = 'anonymous'): () => void {
    const list = this.subscribers.get(event) ?? [];
    const subscription: Subscription = {
      handler: handler as EventHandler<EventName>,
      label,
    };
    list.push(subscription);
    this.subscribers.set(event, list);

    return () => {
      const current = this.subscribers.get(event);
      if (!current) return;
      const index = current.indexOf(subscription);
      if (index !== -1) current.splice(index, 1);
    };
  }

  /**
   * Publish an event.
   *
   * Handlers are awaited together and their failures are isolated: one broken
   * subscriber must not prevent the others from running, and must never fail
   * the request that published the event.
   */
  async emit<E extends EventName>(event: E, payload: DomainEvents[E]): Promise<void> {
    const list = this.subscribers.get(event);

    if (list && list.length > 0) {
      const results = await Promise.allSettled(
        list.map(async (subscription) => {
          try {
            await subscription.handler(payload);
          } catch (error) {
            log.error(
              { event, subscriber: subscription.label, err: error },
              'event handler failed',
            );
            throw error;
          }
        }),
      );

      const failures = results.filter((result) => result.status === 'rejected').length;
      if (failures > 0) {
        log.warn({ event, failures, total: list.length }, 'some event handlers failed');
      }
    }

    // Fan out to other instances so their caches invalidate too.
    if (this.redisPublish) {
      try {
        await this.redisPublish('apihub:events', JSON.stringify({ event, payload }));
      } catch (error) {
        log.warn({ err: error, event }, 'cross-instance event publish failed');
      }
    }
  }

  /** Fire-and-forget publish for call sites that must not await. */
  emitAsync<E extends EventName>(event: E, payload: DomainEvents[E]): void {
    void this.emit(event, payload).catch((error: unknown) => {
      log.error({ err: error, event }, 'async event emit failed');
    });
  }

  /**
   * Subscribe this process to events published by other instances.
   *
   * The subscriber connection is a duplicate: a Redis client in subscribe mode
   * cannot issue normal commands, so it must not be the shared client.
   */
  async connectCrossInstance(): Promise<boolean> {
    const redis = await getRedis();
    if (!redis) return false;

    try {
      this.redisPublish = (channel, message) => redis.publish(channel, message);

      const subscriber = redis.duplicate();
      await subscriber.subscribe('apihub:events');

      subscriber.on('message', ((_channel: string, message: string) => {
        try {
          const parsed = JSON.parse(message) as { event: EventName; payload: unknown };
          // Deliver locally only; re-publishing would create an infinite loop.
          void this.emitLocal(parsed.event, parsed.payload as DomainEvents[EventName]);
        } catch (error) {
          log.warn({ err: error }, 'malformed cross-instance event');
        }
      }) as never);

      log.info('cross-instance event bus connected');
      return true;
    } catch (error) {
      log.warn({ err: error }, 'cross-instance event bus unavailable');
      return false;
    }
  }

  private async emitLocal<E extends EventName>(event: E, payload: DomainEvents[E]): Promise<void> {
    const list = this.subscribers.get(event);
    if (!list) return;
    await Promise.allSettled(list.map((subscription) => subscription.handler(payload)));
  }

  /** Subscriber count, for tests and diagnostics. */
  listenerCount(event: EventName): number {
    return this.subscribers.get(event)?.length ?? 0;
  }

  clear(): void {
    this.subscribers.clear();
  }
}

/** Process-wide bus. */
export const events = new EventBus();

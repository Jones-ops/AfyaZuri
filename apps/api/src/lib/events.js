/**
 * Internal domain event bus backed by a transactional outbox.
 *
 * Modules publish events inside the transaction that made the change, so an
 * event exists if and only if the change committed. A dispatcher later reads
 * pending rows (FOR UPDATE SKIP LOCKED, safe with several API instances) and
 * calls the in-process subscribers. Handlers must be idempotent: delivery is
 * at-least-once.
 */
export class EventBus {
  /** @param {{logger?: import('pino').Logger, maxAttempts?: number}} [opts] */
  constructor(opts = {}) {
    /** @type {Map<string, Array<(event: OutboxEvent, db: import('knex').Knex) => Promise<void>>>} */
    this.handlers = new Map();
    this.logger = opts.logger;
    this.maxAttempts = opts.maxAttempts ?? 8;
  }

  /**
   * @param {string} type
   * @param {(event: OutboxEvent, db: import('knex').Knex) => Promise<void>} handler
   */
  subscribe(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  /**
   * Write an event to the outbox within the caller's transaction.
   * @param {import('knex').Knex.Transaction | import('knex').Knex} trx
   * @param {{type: string, aggregateType: string, aggregateId: string, facilityId?: string|null, payload?: object}} evt
   */
  async publish(trx, evt) {
    await trx('outbox_events').insert({
      event_type: evt.type,
      aggregate_type: evt.aggregateType,
      aggregate_id: evt.aggregateId,
      facility_id: evt.facilityId ?? null,
      payload: JSON.stringify(evt.payload ?? {}),
    });
  }

  /**
   * Deliver up to `limit` pending events. Returns how many were processed.
   * @param {import('knex').Knex} db
   * @param {{limit?: number}} [opts]
   */
  async dispatchPending(db, opts = {}) {
    const limit = opts.limit ?? 50;
    return db.transaction(async (trx) => {
      const events = await trx('outbox_events')
        .where('status', 'pending')
        .andWhere('available_at', '<=', trx.fn.now())
        .orderBy('occurred_at')
        .limit(limit)
        .forUpdate()
        .skipLocked();
      for (const e of events) {
        try {
          for (const h of this.handlers.get(e.event_type) ?? []) await h(e, db);
          await trx('outbox_events').where({ id: e.id }).update({ status: 'done', processed_at: trx.fn.now() });
        } catch (err) {
          const attempts = e.attempts + 1;
          this.logger?.warn({ err, eventId: e.id, type: e.event_type, attempts }, 'outbox handler failed');
          await trx('outbox_events')
            .where({ id: e.id })
            .update({
              attempts,
              last_error: String(err?.message ?? err).slice(0, 1000),
              status: attempts >= this.maxAttempts ? 'failed' : 'pending',
              // exponential backoff: 2s, 4s, 8s … capped at 10 minutes
              available_at: trx.raw(`now() + make_interval(secs => ?)`, [Math.min(2 ** attempts, 600)]),
            });
        }
      }
      return events.length;
    });
  }
}

/**
 * @typedef {Object} OutboxEvent
 * @property {string} id
 * @property {string} event_type
 * @property {string} aggregate_type
 * @property {string} aggregate_id
 * @property {string|null} facility_id
 * @property {Record<string, any>} payload
 * @property {number} attempts
 */

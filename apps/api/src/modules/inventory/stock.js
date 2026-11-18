import '../../lib/db-types.js';
// The stock engine. Every change to on-hand stock goes through moveStock(), which locks the
// store/batch level, refuses to go below zero, and writes the ledger row in the same
// transaction. Callers pass their own transaction so a dispense, its stock movement and its
// bill line commit (or fail) together.
import { fromMilli, todayNairobi, toMilli } from '@afyazuri/shared';
import { AppError } from '../../lib/errors.js';

/**
 * @typedef {{facilityId: string, storeId: string, itemId: string, batchId: string, quantity: number,
 *   type: string, unitCost?: string|number, referenceType?: string|null, referenceId?: string|null,
 *   reason?: string|null, userId?: string|null}} Movement
 */

/**
 * Apply one signed movement to a store/batch and record it in the ledger.
 * @param {import('knex').Knex.Transaction} trx @param {Movement} m
 * @returns {Promise<{balanceAfter: number, movementId: string}>}
 */
export async function moveStock(trx, m) {
  if (toMilli(m.quantity) === 0) throw new Error('moveStock: zero quantity');
  await trx('stock_levels')
    .insert({ store_id: m.storeId, batch_id: m.batchId, item_id: m.itemId, quantity: 0 })
    .onConflict(['store_id', 'batch_id'])
    .ignore();
  const level = await trx('stock_levels').where({ store_id: m.storeId, batch_id: m.batchId }).forUpdate().first();
  const after = toMilli(level.quantity) + toMilli(m.quantity);
  if (after < 0)
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Not enough stock in that batch', {
      available: fromMilli(toMilli(level.quantity)),
    });
  await trx('stock_levels')
    .where({ store_id: m.storeId, batch_id: m.batchId })
    .update({ quantity: fromMilli(after), updated_at: trx.fn.now() });
  const [row] = await trx('stock_movements')
    .insert({
      facility_id: m.facilityId,
      store_id: m.storeId,
      item_id: m.itemId,
      batch_id: m.batchId,
      movement_type: m.type,
      quantity: fromMilli(toMilli(m.quantity)),
      balance_after: fromMilli(after),
      unit_cost: m.unitCost ?? 0,
      reference_type: m.referenceType ?? null,
      reference_id: m.referenceId ?? null,
      reason: m.reason ?? null,
      created_by: m.userId ?? null,
    })
    .returning('id');
  return { balanceAfter: after / 1000, movementId: String(row.id) };
}

/**
 * Pick batches first-expiry-first-out for a quantity, skipping expired stock (it is quarantined
 * from dispensing and issuing). Locks the chosen levels; throws INSUFFICIENT_STOCK with what is
 * usable when there is not enough.
 * @param {import('knex').Knex.Transaction} trx
 * @param {{storeId: string, itemId: string, quantity: number, batchId?: string|null}} r
 * @returns {Promise<Array<{batchId: string, quantity: number, expiryDate: string, batchNumber: string, unitCost: string}>>}
 */
export async function allocateFefo(trx, r) {
  const today = todayNairobi();
  const rows = await trx('stock_levels as l')
    .join('item_batches as b', 'b.id', 'l.batch_id')
    .where({ 'l.store_id': r.storeId, 'l.item_id': r.itemId })
    .andWhere('l.quantity', '>', 0)
    .andWhere('b.expiry_date', '>=', today)
    .modify((q) => r.batchId && q.andWhere('l.batch_id', r.batchId))
    .orderBy([
      { column: 'b.expiry_date', order: 'asc' },
      { column: 'b.created_at', order: 'asc' },
    ])
    .forUpdate('l')
    .select('l.batch_id', 'l.quantity', 'b.expiry_date', 'b.batch_number', 'b.unit_cost');
  let need = toMilli(r.quantity);
  const picks = [];
  for (const row of rows) {
    if (need <= 0) break;
    const take = Math.min(need, toMilli(row.quantity));
    picks.push({
      batchId: row.batch_id,
      quantity: take / 1000,
      expiryDate: String(row.expiry_date).slice(0, 10),
      batchNumber: row.batch_number,
      unitCost: row.unit_cost,
    });
    need -= take;
  }
  if (need > 0) {
    const usable = rows.reduce((s, x) => s + toMilli(x.quantity), 0);
    throw new AppError(409, 'INSUFFICIENT_STOCK', `Only ${fromMilli(usable)} in date in this store`, {
      available: fromMilli(usable),
      itemId: r.itemId,
    });
  }
  return picks;
}

/**
 * Update the facility's weighted average cost for an item after receiving stock.
 * new = (on-hand × old + received × cost) / (on-hand + received). Call before moving the stock in.
 * @param {import('knex').Knex.Transaction} trx @param {string} itemId @param {number} receivedQty @param {string} cost
 */
export async function updateAverageCost(trx, itemId, receivedQty, cost) {
  const item = await trx('items').where({ id: itemId }).forUpdate().first('average_cost', 'facility_id');
  const { rows } = await trx.raw(
    `SELECT COALESCE(sum(l.quantity), 0) AS on_hand FROM stock_levels l JOIN stores s ON s.id = l.store_id
     WHERE l.item_id = ? AND s.facility_id = ?`,
    [itemId, item.facility_id],
  );
  const onHand = Number(rows[0].on_hand);
  const total = onHand + receivedQty;
  const avg = total > 0 ? (onHand * Number(item.average_cost) + receivedQty * Number(cost)) / total : Number(cost);
  await trx('items')
    .where({ id: itemId })
    .update({ average_cost: avg.toFixed(4) });
  return avg.toFixed(4);
}

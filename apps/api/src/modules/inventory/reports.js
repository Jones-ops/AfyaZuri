import '../../lib/db-types.js';
// Inventory reports from the ledger.
//   Consumption: what each department used, by item: dispensing and over-the-counter sales from
//     dispensing stores, and stock issued into departmental stores (wards, lab, theatre), which is
//     consumed there. Losses (expiry write-offs, stock-take shortfalls) are reported apart.
//   Valuation: stock on hand at weighted average cost, by store and category.
import { fromMilli, todayNairobi, toMilli } from '@afyazuri/shared';
import { facilityOf } from './service.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{db: import('knex').Knex}} Deps
 */

const TZ = 'Africa/Nairobi';
const q3 = (v) => fromMilli(toMilli(v ?? 0));
const kes = (v) => Number(v ?? 0).toFixed(2);

/** @param {Deps} deps @param {AuthContext} auth @param {{from: string, to: string, storeId?: string}} q */
export async function consumptionReport({ db }, auth, q) {
  const f = facilityOf(auth);
  const day = `(m.created_at AT TIME ZONE '${TZ}')::date`;
  const storeFilter = q.storeId ? 'AND s.id = :store' : '';
  const bind = { f, from: q.from, to: q.to, store: q.storeId ?? null };
  const used = `(m.movement_type IN ('dispense', 'otc_sale', 'dispense_return')
                OR (m.movement_type = 'issue_in' AND NOT s.dispensing AND s.type <> 'main'))`;
  const { rows } = await db.raw(
    `SELECT d.name AS department, i.id AS item_id, i.code, i.name AS item, i.base_unit, i.category,
            sum(CASE WHEN m.movement_type = 'issue_in' THEN m.quantity ELSE -m.quantity END) AS qty,
            sum(CASE WHEN m.movement_type = 'issue_in' THEN m.quantity ELSE -m.quantity END * m.unit_cost) AS value
     FROM stock_movements m
     JOIN stores s ON s.id = m.store_id
     JOIN departments d ON d.id = s.department_id
     JOIN items i ON i.id = m.item_id
     WHERE m.facility_id = :f AND ${day} BETWEEN :from AND :to AND ${used} ${storeFilter}
     GROUP BY d.name, i.id
     HAVING sum(CASE WHEN m.movement_type = 'issue_in' THEN m.quantity ELSE -m.quantity END) <> 0
     ORDER BY d.name, value DESC, i.name`,
    bind,
  );
  const { rows: lossRows } = await db.raw(
    `SELECT s.name AS store, m.movement_type AS type, i.name AS item, i.base_unit,
            sum(m.quantity) AS qty, sum(m.quantity * m.unit_cost) AS value
     FROM stock_movements m
     JOIN stores s ON s.id = m.store_id
     JOIN items i ON i.id = m.item_id
     WHERE m.facility_id = :f AND ${day} BETWEEN :from AND :to
       AND m.movement_type IN ('expiry_writeoff', 'stocktake', 'adjustment') ${storeFilter}
     GROUP BY s.name, m.movement_type, i.id
     ORDER BY value, s.name`,
    bind,
  );
  const departments = new Map();
  for (const r of rows) {
    const d = departments.get(r.department) ?? { department: r.department, value: 0, items: [] };
    d.value += Number(r.value);
    d.items.push({
      itemId: r.item_id,
      code: r.code,
      item: r.item,
      category: r.category,
      baseUnit: r.base_unit,
      quantity: q3(r.qty),
      value: kes(r.value),
    });
    departments.set(r.department, d);
  }
  const losses = lossRows.map((r) => ({
    store: r.store,
    type: r.type,
    item: r.item,
    baseUnit: r.base_unit,
    quantity: q3(r.qty),
    value: kes(r.value),
  }));
  return {
    from: q.from,
    to: q.to,
    totalValue: kes([...departments.values()].reduce((s, d) => s + d.value, 0)),
    departments: [...departments.values()].map((d) => ({ ...d, value: kes(d.value) })),
    losses,
    lossValue: kes(losses.reduce((s, l) => s + Math.min(Number(l.value), 0), 0)),
    gainValue: kes(losses.reduce((s, l) => s + Math.max(Number(l.value), 0), 0)),
  };
}

/** Stock on hand at weighted average cost. @param {Deps} deps @param {AuthContext} auth @param {{storeId?: string}} q */
export async function valuationReport({ db }, auth, q = {}) {
  const f = facilityOf(auth);
  const today = todayNairobi();
  const { rows } = await db.raw(
    `SELECT s.id AS store_id, s.name AS store, i.id AS item_id, i.code, i.name AS item, i.category, i.base_unit,
            i.average_cost,
            sum(l.quantity) FILTER (WHERE b.expiry_date >= :today) AS usable,
            sum(l.quantity) FILTER (WHERE b.expiry_date < :today) AS expired
     FROM stock_levels l
     JOIN stores s ON s.id = l.store_id
     JOIN items i ON i.id = l.item_id
     JOIN item_batches b ON b.id = l.batch_id
     WHERE s.facility_id = :f AND l.quantity > 0 ${q.storeId ? 'AND s.id = :store' : ''}
     GROUP BY s.id, i.id
     ORDER BY s.name, i.name`,
    { f, today, store: q.storeId ?? null },
  );
  const lines = rows.map((r) => {
    const usable = Number(r.usable ?? 0);
    const expired = Number(r.expired ?? 0);
    return {
      storeId: r.store_id,
      store: r.store,
      itemId: r.item_id,
      code: r.code,
      item: r.item,
      category: r.category,
      baseUnit: r.base_unit,
      usable: q3(usable),
      expired: q3(expired),
      averageCost: Number(r.average_cost).toFixed(4),
      value: kes(usable * Number(r.average_cost)),
      expiredValue: kes(expired * Number(r.average_cost)),
    };
  });
  const by = (key) => {
    const m = new Map();
    for (const l of lines) {
      const k = l[key];
      const e = m.get(k) ?? { [key]: k, items: 0, value: 0, expiredValue: 0 };
      e.items += 1;
      e.value += Number(l.value);
      e.expiredValue += Number(l.expiredValue);
      m.set(k, e);
    }
    return [...m.values()].map((e) => ({ ...e, value: kes(e.value), expiredValue: kes(e.expiredValue) }));
  };
  return {
    asOf: today,
    totalValue: kes(lines.reduce((s, l) => s + Number(l.value), 0)),
    expiredValue: kes(lines.reduce((s, l) => s + Number(l.expiredValue), 0)),
    byStore: by('store'),
    byCategory: by('category'),
    lines,
  };
}

export const consumptionCsv = (r) => [
  ['Department', 'Item code', 'Item', 'Category', 'Quantity', 'Unit', 'Value (KES)'],
  r.departments.flatMap((d) =>
    d.items.map((i) => [d.department, i.code, i.item, i.category, i.quantity, i.baseUnit, i.value]),
  ),
];
export const valuationCsv = (r) => [
  [
    'Store',
    'Item code',
    'Item',
    'Category',
    'Usable',
    'Expired',
    'Unit',
    'Average cost',
    'Value (KES)',
    'Expired value (KES)',
  ],
  r.lines.map((l) => [
    l.store,
    l.code,
    l.item,
    l.category,
    l.usable,
    l.expired,
    l.baseUnit,
    l.averageCost,
    l.value,
    l.expiredValue,
  ]),
];

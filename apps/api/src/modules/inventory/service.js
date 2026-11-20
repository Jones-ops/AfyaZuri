import '../../lib/db-types.js';
// Inventory master data and stock views: stores, items (with drug details and pack sizes),
// suppliers, reorder levels, stock on hand with low-stock status, expiry and the ledger.
import { fromMilli, hasPermission, todayNairobi, toMilli } from '@afyazuri/shared';
import { camel } from '../../lib/case.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{ip?: string|null, userAgent?: string|null, requestId?: string|null}} Meta
 * @typedef {{db: import('knex').Knex}} Deps
 */

export const actorOf = (a) => ({ userId: a.userId, username: a.username, roles: a.roles, facilityId: a.facilityId });
export const facilityOf = (auth) => {
  if (!auth.facilityId) throw badRequest('Select a facility first');
  return auth.facilityId;
};
const q3 = (v) => fromMilli(toMilli(v ?? 0));

/**
 * Load a store of this facility and check the user holds `perm` for its department
 * (a pharmacist works the pharmacy store, a storekeeper the main store).
 * @param {import('knex').Knex | import('knex').Knex.Transaction} db @param {AuthContext} auth
 * @param {string} storeId @param {string} perm
 */
export async function storeFor(db, auth, storeId, perm) {
  const store = await db('stores')
    .where({ id: storeId, facility_id: facilityOf(auth) })
    .first();
  if (!store) throw notFound('Store');
  if (!store.active) throw conflict(`${store.name} is closed`);
  if (!hasPermission(auth.grants, perm, { facilityId: store.facility_id, departmentId: store.department_id }))
    throw forbidden(`You cannot do that in ${store.name}`, { required: [perm] });
  return store;
}

// ---- Stores ---------------------------------------------------------------------------------

const toStore = (s) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  type: s.type,
  departmentId: s.department_id,
  departmentName: s.department_name ?? null,
  dispensing: s.dispensing,
  active: s.active,
});

/** @param {Deps} deps @param {AuthContext} auth */
export async function listStores({ db }, auth) {
  const rows = await db('stores as s')
    .join('departments as d', 'd.id', 's.department_id')
    .where('s.facility_id', facilityOf(auth))
    .orderBy('s.name')
    .select('s.*', 'd.name as department_name');
  return rows.map(toStore);
}

async function checkDepartment(db, facilityId, departmentId) {
  const d = await db('departments').where({ id: departmentId, facility_id: facilityId }).first('id');
  if (!d) throw badRequest('That department is not at this facility');
}

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createStore({ db }, auth, input, meta) {
  const f = facilityOf(auth);
  return db.transaction(async (trx) => {
    await checkDepartment(trx, f, input.departmentId);
    if (await trx('stores').where({ facility_id: f, code: input.code }).first('id'))
      throw conflict(`Store code ${input.code} is taken`);
    const [s] = await trx('stores')
      .insert({
        facility_id: f,
        code: input.code,
        name: input.name,
        type: input.type,
        department_id: input.departmentId,
        dispensing: input.dispensing,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, { action: 'create', entityType: 'store', entityId: s.id, after: s });
    return toStore(s);
  });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta */
export async function updateStore({ db }, auth, id, input, meta) {
  const f = facilityOf(auth);
  return db.transaction(async (trx) => {
    const before = await trx('stores').where({ id, facility_id: f }).forUpdate().first();
    if (!before) throw notFound('Store');
    if (input.departmentId) await checkDepartment(trx, f, input.departmentId);
    const patch = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.departmentId !== undefined && { department_id: input.departmentId }),
      ...(input.dispensing !== undefined && { dispensing: input.dispensing }),
      ...(input.active !== undefined && { active: input.active }),
      updated_by: auth.userId,
    };
    const [after] = await trx('stores').where({ id }).update(patch).returning('*');
    await recordAudit(trx, actorOf(auth), meta, { action: 'update', entityType: 'store', entityId: id, before, after });
    return toStore(after);
  });
}

// ---- Items ---------------------------------------------------------------------------------

const toItem = (i, packs = []) => ({
  id: i.id,
  code: i.code,
  name: i.name,
  category: i.category,
  baseUnit: i.base_unit,
  chargeItemId: i.charge_item_id,
  chargeItemName: i.charge_item_name ?? null,
  averageCost: Number(i.average_cost).toFixed(4),
  active: i.active,
  drug: i.generic_name
    ? {
        genericName: i.generic_name,
        brandName: i.brand_name,
        form: i.form,
        strength: i.strength,
        strengthValue: i.strength_value === null ? null : Number(i.strength_value),
        strengthUnit: i.strength_unit,
        defaultRoute: i.default_route,
        keml: i.keml,
        atcCode: i.atc_code,
        controlled: i.controlled,
        otcAllowed: i.otc_allowed,
      }
    : null,
  packSizes: packs.map((p) => ({ id: p.id, name: p.name, baseQty: Number(p.base_qty) })),
});

const itemQuery = (db) =>
  db('items as i')
    .leftJoin('drugs as d', 'd.item_id', 'i.id')
    .leftJoin('charge_items as c', 'c.id', 'i.charge_item_id')
    .select('i.*', 'd.*', 'i.id as id', 'c.name as charge_item_name');

async function withPacks(db, rows) {
  const packs = rows.length
    ? await db('item_pack_sizes')
        .whereIn(
          'item_id',
          rows.map((r) => r.id),
        )
        .orderBy('base_qty')
    : [];
  return rows.map((r) =>
    toItem(
      r,
      packs.filter((p) => p.item_id === r.id),
    ),
  );
}

/** @param {Deps} deps @param {AuthContext} auth @param {any} q */
export async function listItems({ db }, auth, q) {
  const rows = await itemQuery(db)
    .where('i.facility_id', facilityOf(auth))
    .modify((x) => {
      if (q.category) x.andWhere('i.category', q.category);
      if (q.active) x.andWhere('i.active', q.active === 'true');
      if (q.q) {
        const like = `%${q.q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        x.andWhere((w) =>
          w
            .whereRaw('lower(i.name) LIKE ?', [like])
            .orWhereRaw('lower(i.code) LIKE ?', [like])
            .orWhereRaw('lower(d.generic_name) LIKE ?', [like])
            .orWhereRaw('lower(d.brand_name) LIKE ?', [like]),
        );
      }
    })
    .orderBy('i.name')
    .limit(q.limit);
  return withPacks(db, rows);
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id */
export async function getItem({ db }, auth, id) {
  const row = await itemQuery(db)
    .where({ 'i.id': id, 'i.facility_id': facilityOf(auth) })
    .first();
  if (!row) throw notFound('Item');
  return (await withPacks(db, [row]))[0];
}

async function checkChargeItem(db, facilityId, chargeItemId) {
  if (!chargeItemId) return;
  const c = await db('charge_items').where({ id: chargeItemId, facility_id: facilityId }).first('id');
  if (!c) throw badRequest('That billing item is not at this facility');
}

const drugRow = (d) => {
  if (d.controlled && d.otcAllowed) throw badRequest('A controlled drug cannot be sold over the counter');
  return drugRowUnchecked(d);
};
const drugRowUnchecked = (d) => ({
  generic_name: d.genericName,
  brand_name: d.brandName ?? null,
  form: d.form,
  strength: d.strength ?? null,
  strength_value: d.strengthValue ?? null,
  strength_unit: d.strengthUnit ?? null,
  default_route: d.defaultRoute ?? null,
  keml: d.keml ?? false,
  atc_code: d.atcCode ?? null,
  controlled: d.controlled ?? false,
  otc_allowed: d.otcAllowed ?? false,
});

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createItem({ db }, auth, input, meta) {
  const f = facilityOf(auth);
  const id = await db.transaction(async (trx) => {
    if (await trx('items').where({ facility_id: f, code: input.code }).first('id'))
      throw conflict(`Item code ${input.code} is taken`);
    await checkChargeItem(trx, f, input.chargeItemId);
    const [item] = await trx('items')
      .insert({
        facility_id: f,
        code: input.code,
        name: input.name,
        category: input.category,
        base_unit: input.baseUnit,
        charge_item_id: input.chargeItemId ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    if (input.drug) await trx('drugs').insert({ item_id: item.id, ...drugRow(input.drug) });
    if (input.packSizes.length)
      await trx('item_pack_sizes').insert(
        input.packSizes.map((p) => ({ item_id: item.id, name: p.name, base_qty: p.baseQty })),
      );
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'create',
      entityType: 'item',
      entityId: item.id,
      after: { ...item, drug: input.drug ?? null, packSizes: input.packSizes },
    });
    return item.id;
  });
  return getItem({ db }, auth, id);
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta */
export async function updateItem({ db }, auth, id, input, meta) {
  const f = facilityOf(auth);
  await db.transaction(async (trx) => {
    const before = await trx('items').where({ id, facility_id: f }).forUpdate().first();
    if (!before) throw notFound('Item');
    if (input.chargeItemId) await checkChargeItem(trx, f, input.chargeItemId);
    const patch = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.baseUnit !== undefined && { base_unit: input.baseUnit }),
      ...(input.chargeItemId !== undefined && { charge_item_id: input.chargeItemId }),
      ...(input.active !== undefined && { active: input.active }),
      updated_by: auth.userId,
    };
    const [after] = await trx('items').where({ id }).update(patch).returning('*');
    let drugBefore = null;
    if (input.drug) {
      drugBefore = await trx('drugs').where({ item_id: id }).first();
      if (!drugBefore) throw badRequest('This item has no drug details to change');
      const d = Object.fromEntries(
        Object.entries(drugRow({ ...camel(drugBefore), ...input.drug })).filter(([k]) => k !== 'item_id'),
      );
      await trx('drugs').where({ item_id: id }).update(d);
    }
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'item',
      entityId: id,
      before: { ...before, drug: drugBefore },
      after: { ...after, drug: input.drug ?? undefined },
    });
  });
  return getItem({ db }, auth, id);
}

// ---- Suppliers ------------------------------------------------------------------------------

const toSupplier = (s) => camel(s, ['created_by', 'updated_by', 'facility_id', 'created_at', 'updated_at']);

/** @param {Deps} deps @param {AuthContext} auth */
export async function listSuppliers({ db }, auth) {
  return (
    await db('suppliers')
      .where({ facility_id: facilityOf(auth) })
      .orderBy('name')
  ).map(toSupplier);
}

/** @param {Deps} deps @param {AuthContext} auth @param {any} input @param {Meta} meta */
export async function createSupplier({ db }, auth, input, meta) {
  const f = facilityOf(auth);
  return db.transaction(async (trx) => {
    if (await trx('suppliers').where({ facility_id: f, name: input.name }).first('id'))
      throw conflict(`${input.name} is already a supplier`);
    const [s] = await trx('suppliers')
      .insert({
        facility_id: f,
        name: input.name,
        kra_pin: input.kraPin ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, { action: 'create', entityType: 'supplier', entityId: s.id, after: s });
    return toSupplier(s);
  });
}

/** @param {Deps} deps @param {AuthContext} auth @param {string} id @param {any} input @param {Meta} meta */
export async function updateSupplier({ db }, auth, id, input, meta) {
  const f = facilityOf(auth);
  return db.transaction(async (trx) => {
    const before = await trx('suppliers').where({ id, facility_id: f }).forUpdate().first();
    if (!before) throw notFound('Supplier');
    const map = {
      name: 'name',
      kraPin: 'kra_pin',
      phone: 'phone',
      email: 'email',
      address: 'address',
      active: 'active',
    };
    const patch = Object.fromEntries(
      Object.entries(map)
        .filter(([k]) => input[k] !== undefined)
        .map(([k, col]) => [col, input[k]]),
    );
    const [after] = await trx('suppliers')
      .where({ id })
      .update({ ...patch, updated_by: auth.userId })
      .returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: 'update',
      entityType: 'supplier',
      entityId: id,
      before,
      after,
    });
    return toSupplier(after);
  });
}

// ---- Reorder levels and stock on hand --------------------------------------------------------

/** @param {Deps} deps @param {AuthContext} auth @param {string} storeId @param {string} itemId @param {any} input @param {Meta} meta */
export async function setReorderLevel({ db }, auth, storeId, itemId, input, meta) {
  return db.transaction(async (trx) => {
    const store = await storeFor(trx, auth, storeId, 'inventory.items.manage');
    const item = await trx('items').where({ id: itemId, facility_id: store.facility_id }).first('id');
    if (!item) throw notFound('Item');
    const before = await trx('reorder_levels').where({ store_id: storeId, item_id: itemId }).first();
    const row = {
      store_id: storeId,
      item_id: itemId,
      reorder_level: input.reorderLevel,
      reorder_qty: input.reorderQty,
      max_level: input.maxLevel ?? null,
      updated_by: auth.userId,
      updated_at: trx.fn.now(),
    };
    const [after] = await trx('reorder_levels').insert(row).onConflict(['store_id', 'item_id']).merge().returning('*');
    await recordAudit(trx, actorOf(auth), meta, {
      action: before ? 'update' : 'create',
      entityType: 'reorder_level',
      entityId: itemId,
      before,
      after,
      metadata: { store: store.code },
    });
    return {
      reorderLevel: q3(after.reorder_level),
      reorderQty: q3(after.reorder_qty),
      maxLevel: after.max_level && q3(after.max_level),
    };
  });
}

/** Low = usable stock at or below the reorder level. Suggest topping up to the maximum, or the reorder quantity. */
export function stockStatus(usable, r) {
  const u = toMilli(usable);
  if (u === 0) return 'out';
  if (r?.reorder_level != null && u <= toMilli(r.reorder_level)) return 'low';
  return 'ok';
}
export function suggestedOrder(usable, r) {
  if (!r || toMilli(usable) > toMilli(r.reorder_level)) return 0;
  const toMax = r.max_level != null ? toMilli(r.max_level) - toMilli(usable) : 0;
  return Math.max(toMilli(r.reorder_qty), toMax) / 1000;
}

/**
 * Stock on hand in one store, per item: usable (in date), expired (quarantined), expiring within
 * 90 days, next expiry, reorder status and value at weighted average cost.
 * @param {Deps} deps @param {AuthContext} auth @param {string} storeId @param {{q?: string, status?: string}} [q]
 */
export async function storeStock({ db }, auth, storeId, q = {}) {
  const store = await db('stores')
    .where({ id: storeId, facility_id: facilityOf(auth) })
    .first();
  if (!store) throw notFound('Store');
  const today = todayNairobi();
  const { rows } = await db.raw(
    `SELECT i.id, i.code, i.name, i.base_unit, i.category, i.average_cost,
            d.generic_name, d.strength, d.form,
            COALESCE(sum(l.quantity) FILTER (WHERE b.expiry_date >= :today), 0) AS usable,
            COALESCE(sum(l.quantity) FILTER (WHERE b.expiry_date <  :today), 0) AS expired,
            COALESCE(sum(l.quantity) FILTER (WHERE b.expiry_date >= :today AND b.expiry_date < :today::date + 90), 0) AS expiring,
            min(b.expiry_date) FILTER (WHERE b.expiry_date >= :today) AS next_expiry,
            r.reorder_level, r.reorder_qty, r.max_level
     FROM items i
     LEFT JOIN stock_levels l ON l.item_id = i.id AND l.store_id = :store AND l.quantity > 0
     LEFT JOIN item_batches b ON b.id = l.batch_id
     LEFT JOIN reorder_levels r ON r.item_id = i.id AND r.store_id = :store
     LEFT JOIN drugs d ON d.item_id = i.id
     WHERE i.facility_id = :facility AND i.active
       AND (l.store_id IS NOT NULL OR r.store_id IS NOT NULL)
     GROUP BY i.id, d.item_id, r.store_id, r.item_id
     ORDER BY i.name`,
    { today, store: storeId, facility: store.facility_id },
  );
  let items = rows.map((r) => {
    const status = stockStatus(r.usable, r);
    return {
      itemId: r.id,
      code: r.code,
      name: r.name,
      category: r.category,
      baseUnit: r.base_unit,
      genericName: r.generic_name,
      strength: r.strength,
      form: r.form,
      usable: q3(r.usable),
      expired: q3(r.expired),
      expiringIn90: q3(r.expiring),
      nextExpiry: r.next_expiry,
      reorderLevel: r.reorder_level === null ? null : q3(r.reorder_level),
      maxLevel: r.max_level === null ? null : q3(r.max_level),
      status,
      suggestedOrder: fromMilli(suggestedOrder(r.usable, r) * 1000),
      value: (Number(r.usable) * Number(r.average_cost)).toFixed(2),
    };
  });
  if (q.q) {
    const s = q.q.toLowerCase();
    items = items.filter((i) => `${i.name} ${i.code} ${i.genericName ?? ''}`.toLowerCase().includes(s));
  }
  if (q.status === 'low') items = items.filter((i) => i.status !== 'ok');
  if (q.status === 'out') items = items.filter((i) => i.status === 'out');
  if (q.status === 'expiring') items = items.filter((i) => toMilli(i.expiringIn90) > 0 || toMilli(i.expired) > 0);
  return { store: toStore(store), asOf: today, items };
}

/** Batches of one item in one store, earliest expiry first, flagged if expired. @param {Deps} deps @param {AuthContext} auth */
export async function itemBatches({ db }, auth, storeId, itemId) {
  const store = await db('stores')
    .where({ id: storeId, facility_id: facilityOf(auth) })
    .first('id');
  if (!store) throw notFound('Store');
  const today = todayNairobi();
  const rows = await db('stock_levels as l')
    .join('item_batches as b', 'b.id', 'l.batch_id')
    .leftJoin('suppliers as s', 's.id', 'b.supplier_id')
    .where({ 'l.store_id': storeId, 'l.item_id': itemId })
    .andWhere('l.quantity', '>', 0)
    .orderBy('b.expiry_date')
    .select('b.id', 'b.batch_number', 'b.expiry_date', 'b.unit_cost', 'l.quantity', 's.name as supplier');
  return rows.map((b) => ({
    batchId: b.id,
    batchNumber: b.batch_number,
    expiryDate: b.expiry_date,
    expired: b.expiry_date < today,
    quantity: q3(b.quantity),
    unitCost: Number(b.unit_cost).toFixed(4),
    supplier: b.supplier,
  }));
}

/** Expiry bands. @param {string} expiry @param {string} today */
export function expiryBand(expiry, today) {
  const days = Math.round((Date.parse(expiry) - Date.parse(today)) / 86_400_000);
  if (days < 0) return 'expired';
  if (days <= 30) return '30';
  if (days <= 60) return '60';
  if (days <= 90) return '90';
  return null;
}

/**
 * Batches with stock that are expired or expire within 90 days, across the facility's stores
 * (or one store), with their value at cost.
 * @param {Deps} deps @param {AuthContext} auth @param {{storeId?: string}} [q]
 */
export async function expiryReport({ db }, auth, q = {}) {
  const f = facilityOf(auth);
  const today = todayNairobi();
  const rows = await db('stock_levels as l')
    .join('item_batches as b', 'b.id', 'l.batch_id')
    .join('items as i', 'i.id', 'l.item_id')
    .join('stores as s', 's.id', 'l.store_id')
    .where('s.facility_id', f)
    .andWhere('l.quantity', '>', 0)
    .andWhereRaw('b.expiry_date <= ?::date + 90', [today])
    .modify((x) => q.storeId && x.andWhere('s.id', q.storeId))
    .orderBy('b.expiry_date')
    .select(
      's.id as store_id',
      's.name as store',
      'i.id as item_id',
      'i.name as item',
      'i.base_unit',
      'b.id as batch_id',
      'b.batch_number',
      'b.expiry_date',
      'b.unit_cost',
      'l.quantity',
    );
  const batches = rows.map((r) => ({
    storeId: r.store_id,
    store: r.store,
    itemId: r.item_id,
    item: r.item,
    baseUnit: r.base_unit,
    batchId: r.batch_id,
    batchNumber: r.batch_number,
    expiryDate: r.expiry_date,
    band: expiryBand(r.expiry_date, today),
    quantity: q3(r.quantity),
    value: (Number(r.quantity) * Number(r.unit_cost)).toFixed(2),
  }));
  const bands = ['expired', '30', '60', '90'].map((band) => {
    const xs = batches.filter((b) => b.band === band);
    return { band, batches: xs.length, value: xs.reduce((s, b) => s + Number(b.value), 0).toFixed(2) };
  });
  return { asOf: today, bands, batches };
}

/**
 * Low-stock items across every store (what to order or requisition).
 * @param {Deps} deps @param {AuthContext} auth
 */
export async function lowStock({ db }, auth) {
  const stores = await db('stores')
    .where({ facility_id: facilityOf(auth), active: true })
    .orderBy('name');
  const out = [];
  for (const s of stores) {
    const { items } = await storeStock({ db }, auth, s.id, { status: 'low' });
    for (const i of items) out.push({ storeId: s.id, store: s.name, ...i });
  }
  return out;
}

/** The ledger, newest first. @param {Deps} deps @param {AuthContext} auth @param {any} q */
export async function listMovements({ db }, auth, q) {
  const rows = await db('stock_movements as m')
    .join('items as i', 'i.id', 'm.item_id')
    .join('stores as s', 's.id', 'm.store_id')
    .join('item_batches as b', 'b.id', 'm.batch_id')
    .leftJoin('users as u', 'u.id', 'm.created_by')
    .where('m.facility_id', facilityOf(auth))
    .modify((x) => {
      if (q.storeId) x.andWhere('m.store_id', q.storeId);
      if (q.itemId) x.andWhere('m.item_id', q.itemId);
      if (q.before) x.andWhere('m.id', '<', q.before);
    })
    .orderBy('m.id', 'desc')
    .limit(q.limit)
    .select(
      'm.*',
      'i.name as item',
      'i.base_unit',
      's.name as store',
      'b.batch_number',
      'b.expiry_date',
      'u.full_name as by',
    );
  return rows.map((m) => ({
    id: Number(m.id),
    at: m.created_at,
    store: m.store,
    item: m.item,
    baseUnit: m.base_unit,
    batchNumber: m.batch_number,
    expiryDate: m.expiry_date,
    type: m.movement_type,
    quantity: q3(m.quantity),
    balanceAfter: q3(m.balance_after),
    unitCost: Number(m.unit_cost).toFixed(4),
    referenceType: m.reference_type,
    referenceId: m.reference_id,
    reason: m.reason,
    by: m.by,
  }));
}

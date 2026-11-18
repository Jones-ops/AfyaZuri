import '../../lib/db-types.js';
// Report receipts and credit notes to KRA eTIMS. Runs from the outbox (after the payment or
// approval has committed) and from a manual retry; safe to run more than once per document.
import { fromCents, toCents } from '@afyazuri/shared';
import { conflict, notFound } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { facilityOf } from '../billing/service.js';

/**
 * @typedef {{db: import('knex').Knex, etims: import('../../integrations/etims.js').EtimsAdapter,
 *            logger?: import('pino').Logger}} Deps
 */

const nameOf = (r) =>
  r.first_name ? [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ') : (r.customer_name ?? null);

/**
 * Split an amount across the bill's VAT rates in proportion to the patient's share of each, so a
 * payment on a mixed bill is reported under the right tax categories. Cents are exact: the
 * remainder goes to the largest group.
 * @param {import('knex').Knex} db @param {string} billId @param {string} amount @param {string} label
 */
export async function linesFor(db, billId, amount, label) {
  const groups = await db('bill_items as i')
    .join('charge_items as c', 'c.id', 'i.charge_item_id')
    .where({ 'i.bill_id': billId, 'i.status': 'active' })
    .groupBy('c.vat_rate')
    .select('c.vat_rate', db.raw('sum(i.patient_amount) AS patient'))
    .orderBy('patient', 'desc');
  const total = toCents(amount);
  const base = groups.reduce((s, g) => s + toCents(g.patient), 0);
  if (!groups.length || base <= 0)
    return [{ description: label, quantity: 1, unitPrice: fromCents(total), amount: fromCents(total), vatRate: 0 }];
  const parts = groups.map((g) => ({
    vatRate: Number(g.vat_rate),
    cents: Math.floor((total * toCents(g.patient)) / base),
  }));
  parts[0].cents += total - parts.reduce((s, p) => s + p.cents, 0);
  return parts
    .filter((p) => p.cents > 0)
    .map((p) => ({
      description: p.vatRate === 0 ? `${label} (VAT exempt)` : `${label} (VAT ${p.vatRate}%)`,
      quantity: 1,
      unitPrice: fromCents(p.cents),
      amount: fromCents(p.cents),
      vatRate: p.vatRate,
    }));
}

/**
 * Report one receipt. Returns its eTIMS status afterwards. Throws when KRA could not be
 * reached, so the outbox retries with backoff.
 * @param {Deps} deps @param {string} receiptId
 */
export async function submitReceipt({ db, etims }, receiptId) {
  const r = await db('receipts as r')
    .join('payments as p', 'p.id', 'r.payment_id')
    .join('bills as b', 'b.id', 'p.bill_id')
    .join('facilities as f', 'f.id', 'r.facility_id')
    .leftJoin('patients as pt', 'pt.id', 'b.patient_id')
    .where('r.id', receiptId)
    .first(
      'r.*',
      'p.amount',
      'p.bill_id',
      'b.bill_number',
      'b.customer_name',
      'f.name as facility_name',
      'f.kmhfl_code',
      'f.kra_pin',
      'pt.first_name',
      'pt.middle_name',
      'pt.last_name',
    );
  if (!r) return null;
  if (r.etims_status === 'submitted' || r.etims_status === 'not_required') return r.etims_status;
  if (!etims.enabled) {
    await db('receipts').where({ id: r.id }).update({ etims_status: 'not_required' });
    return 'not_required';
  }
  const doc = {
    kind: /** @type {const} */ ('sale'),
    documentNumber: r.receipt_number,
    issuedAt: new Date(r.issued_at).toISOString(),
    seller: { name: r.facility_name, kmhflCode: r.kmhfl_code, kraPin: r.kra_pin },
    buyer: { name: nameOf(r) },
    lines: await linesFor(db, r.bill_id, r.amount, `Medical services, bill ${r.bill_number}`),
    total: fromCents(toCents(r.amount)),
  };
  return report(db, 'receipts', r.id, () => etims.submit(doc));
}

/**
 * Report an approved credit note against the bill's latest reported receipt. A bill with no
 * receipts needs no eTIMS credit note (nothing was reported as sold).
 * @param {Deps} deps @param {string} refundId
 */
export async function submitCreditNote({ db, etims }, refundId) {
  const c = await db('refunds as x')
    .join('bills as b', 'b.id', 'x.bill_id')
    .join('facilities as f', 'f.id', 'x.facility_id')
    .leftJoin('patients as pt', 'pt.id', 'b.patient_id')
    .where({ 'x.id': refundId, 'x.kind': 'credit_note', 'x.status': 'approved' })
    .first(
      'x.*',
      'b.bill_number',
      'b.customer_name',
      'f.name as facility_name',
      'f.kmhfl_code',
      'f.kra_pin',
      'pt.first_name',
      'pt.middle_name',
      'pt.last_name',
    );
  if (!c) return null;
  if (c.etims_status === 'submitted' || c.etims_status === 'not_required') return c.etims_status;
  const receipts = await db('receipts as r')
    .join('payments as p', 'p.id', 'r.payment_id')
    .where({ 'p.bill_id': c.bill_id, 'p.status': 'completed' })
    .orderBy('r.issued_at', 'desc')
    .select('r.etims_status', 'r.etims_invoice_number');
  if (!etims.enabled || !receipts.length) {
    await db('refunds').where({ id: c.id }).update({ etims_status: 'not_required' });
    return 'not_required';
  }
  const original = receipts.find((r) => r.etims_status === 'submitted');
  if (!original) throw new Error('eTIMS: the original sale has not been reported yet; will retry');
  const doc = {
    kind: /** @type {const} */ ('credit_note'),
    documentNumber: c.document_number,
    issuedAt: new Date(c.decided_at).toISOString(),
    seller: { name: c.facility_name, kmhflCode: c.kmhfl_code, kraPin: c.kra_pin },
    buyer: { name: nameOf(c) },
    lines: await linesFor(db, c.bill_id, c.amount, `Credit note, bill ${c.bill_number}`),
    total: fromCents(toCents(c.amount)),
    originalInvoiceNumber: original.etims_invoice_number,
  };
  return report(db, 'refunds', c.id, () => etims.submit(doc));
}

/** Submit and record the outcome. Never overwrites a document already reported. */
async function report(db, table, id, submit) {
  try {
    const res = await submit();
    await db(table)
      .where({ id })
      .whereNot({ etims_status: 'submitted' })
      .update({
        etims_status: 'submitted',
        etims_invoice_number: res.invoiceNumber,
        etims_response: JSON.stringify(res),
      });
    return 'submitted';
  } catch (err) {
    await db(table)
      .where({ id })
      .whereNot({ etims_status: 'submitted' })
      .update({
        etims_status: 'failed',
        etims_response: JSON.stringify({
          error: String(err?.message ?? err).slice(0, 300),
          at: new Date().toISOString(),
        }),
      });
    throw err;
  }
}

/**
 * Sweep for documents the outbox could not report (KRA down for hours, or receipts issued before
 * eTIMS was switched on). Oldest first, a bounded batch per run.
 * @param {Deps} deps @param {{limit?: number}} [opts] @returns {Promise<number>} how many were tried
 */
export async function reconcileEtims(deps, opts = {}) {
  const limit = opts.limit ?? 50;
  const stale = (q) => q.where('etims_status', 'pending').orWhere('etims_status', 'failed');
  const receipts = await deps
    .db('receipts')
    .where(stale)
    .andWhere('issued_at', '<', deps.db.raw("now() - interval '5 minutes'"))
    .orderBy('issued_at')
    .limit(limit)
    .pluck('id');
  const notes = await deps
    .db('refunds')
    .where({ kind: 'credit_note', status: 'approved' })
    .andWhere(stale)
    .andWhere('decided_at', '<', deps.db.raw("now() - interval '5 minutes'"))
    .orderBy('decided_at')
    .limit(limit)
    .pluck('id');
  for (const id of receipts) await submitReceipt(deps, id).catch(() => {});
  for (const id of notes) await submitCreditNote(deps, id).catch(() => {});
  return receipts.length + notes.length;
}

/**
 * Staff-triggered retry for a receipt or credit note whose eTIMS submission failed.
 * @param {Deps} deps @param {import('../../middleware/auth.js').AuthContext} auth
 * @param {'receipt'|'credit_note'} kind @param {string} id @param {any} meta
 */
export async function retryEtims(deps, auth, kind, id, meta) {
  const table = kind === 'receipt' ? 'receipts' : 'refunds';
  const row = await deps
    .db(table)
    .where({ id, facility_id: facilityOf(auth) })
    .modify((q) => kind === 'credit_note' && q.where({ kind: 'credit_note' }))
    .first('id', 'etims_status');
  if (!row) throw notFound(kind === 'receipt' ? 'Receipt' : 'Credit note');
  if (row.etims_status === 'submitted') throw conflict('Already reported to eTIMS');
  let status;
  try {
    status = kind === 'receipt' ? await submitReceipt(deps, id) : await submitCreditNote(deps, id);
  } catch (err) {
    deps.logger?.warn({ err, kind, id }, 'eTIMS retry failed');
    status = 'failed';
  }
  await recordAudit(
    deps.db,
    { userId: auth.userId, username: auth.username, roles: auth.roles, facilityId: auth.facilityId },
    meta,
    { action: 'update', entityType: kind, entityId: id, metadata: { etimsRetry: status } },
  );
  return { status };
}

// Outbox subscribers: work that happens after a payment or approval has committed, outside the
// request. Every handler is idempotent (the outbox delivers at least once).
import { submitCreditNote, submitReceipt } from './etims.js';
import { sendPatientSms } from './sms.js';

const registered = new WeakSet();

/** Run independent handlers; fail (so the event is retried) if any failed. */
async function all(...tasks) {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** @param {import('../../app.js').Deps} deps */
export function registerSubscribers(deps) {
  const { bus } = deps;
  if (registered.has(bus)) return;
  registered.add(bus);

  bus.subscribe('payment.completed', async (e, db) => {
    const p = e.payload;
    await all(
      () => submitReceipt({ ...deps, db }, p.receiptId),
      async () => {
        const r = await db('receipts as r')
          .join('payments as pay', 'pay.id', 'r.payment_id')
          .join('bills as b', 'b.id', 'pay.bill_id')
          .where('r.id', p.receiptId)
          .first('r.receipt_number', 'b.patient_id', 'b.facility_id', 'b.balance', 'pay.amount', 'pay.method');
        if (!r) return;
        await sendPatientSms(
          { ...deps, db },
          {
            facilityId: r.facility_id,
            patientId: r.patient_id,
            template: 'payment_received',
            relatedType: 'payment',
            relatedId: e.aggregate_id,
            vars: { amount: r.amount, method: r.method, receipt: r.receipt_number, balance: r.balance },
          },
        );
      },
    );
  });

  bus.subscribe('credit_note.approved', (e, db) => submitCreditNote({ ...deps, db }, e.aggregate_id));

  bus.subscribe('refund.paid', async (e, db) => {
    const f = await db('refunds as f')
      .join('bills as b', 'b.id', 'f.bill_id')
      .where('f.id', e.aggregate_id)
      .first('f.amount', 'f.method', 'f.document_number', 'b.patient_id', 'b.facility_id');
    if (!f) return;
    await sendPatientSms(
      { ...deps, db },
      {
        facilityId: f.facility_id,
        patientId: f.patient_id,
        template: 'refund_paid',
        relatedType: 'refund',
        relatedId: e.aggregate_id,
        vars: { amount: f.amount, method: f.method, document: f.document_number },
      },
    );
  });
}

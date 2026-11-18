import '../../lib/db-types.js';
// Financial reports: daily revenue reconciliation and debtor ageing.
//
// Days are Nairobi calendar days. Every query is scoped to the session's facility and runs in
// SQL numeric (never floats); amounts leave as "1234.50" strings. Patients marked restricted
// are shown by MRN only.
import { fromCents, todayNairobi, toCents } from '@afyazuri/shared';
import { facilityOf } from '../billing/service.js';

/**
 * @typedef {import('../../middleware/auth.js').AuthContext} AuthContext
 * @typedef {{db: import('knex').Knex}} Deps
 */

const TZ = 'Africa/Nairobi';
const money = (v) => fromCents(toCents(v ?? 0));
const localDay = (col) => `(${col} AT TIME ZONE '${TZ}')::date`;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * Daily revenue reconciliation for a date range: what was billed (by department and payer),
 * what was collected and refunded (by method), waivers and credit notes, day by day, and
 * each cashier shift's declared-versus-expected variance.
 * @param {Deps} deps @param {AuthContext} auth @param {{from: string, to: string}} q
 */
export async function revenueReport({ db }, auth, q) {
  const f = facilityOf(auth);
  const range = [q.from, q.to];
  const raw = async (sql, bindings) => (await db.raw(sql, bindings)).rows;

  const itemsInRange = `
    FROM bill_items i
    JOIN bills b ON b.id = i.bill_id
    WHERE i.facility_id = ? AND i.status = 'active' AND b.status <> 'cancelled'
      AND ${localDay('i.posted_at')} BETWEEN ? AND ?`;

  const [departments, payers, patientShare, received, refunded, days, cashiers] = await Promise.all([
    raw(
      `SELECT COALESCE(d.name, 'Unassigned') AS name, count(*)::int AS lines,
              sum(i.total_amount) AS billed, sum(i.payer_amount) AS payer, sum(i.patient_amount) AS patient
       FROM bill_items i
       JOIN bills b ON b.id = i.bill_id
       LEFT JOIN departments d ON d.id = i.department_id
       WHERE i.facility_id = ? AND i.status = 'active' AND b.status <> 'cancelled'
         AND ${localDay('i.posted_at')} BETWEEN ? AND ?
       GROUP BY 1 ORDER BY billed DESC, name`,
      [f, ...range],
    ),
    raw(
      `SELECT py.name AS name, s.name AS scheme, count(DISTINCT b.id)::int AS bills, sum(i.payer_amount) AS billed
       FROM bill_items i
       JOIN bills b ON b.id = i.bill_id
       JOIN patient_payer_schemes ps ON ps.id = b.patient_payer_scheme_id
       JOIN schemes s ON s.id = ps.scheme_id
       JOIN payers py ON py.id = s.payer_id
       WHERE i.facility_id = ? AND i.status = 'active' AND b.status <> 'cancelled' AND i.payer_amount > 0
         AND ${localDay('i.posted_at')} BETWEEN ? AND ?
       GROUP BY 1, 2 ORDER BY billed DESC, name`,
      [f, ...range],
    ),
    raw(`SELECT count(DISTINCT b.id)::int AS bills, COALESCE(sum(i.patient_amount), 0) AS billed ${itemsInRange}`, [
      f,
      ...range,
    ]),
    raw(
      `SELECT method, count(*)::int AS n, sum(amount) AS total FROM payments
       WHERE facility_id = ? AND status = 'completed' AND ${localDay('received_at')} BETWEEN ? AND ?
       GROUP BY method`,
      [f, ...range],
    ),
    raw(
      `SELECT method, count(*)::int AS n, sum(amount) AS total FROM refunds
       WHERE facility_id = ? AND kind = 'refund' AND status = 'paid' AND ${localDay('paid_at')} BETWEEN ? AND ?
       GROUP BY method`,
      [f, ...range],
    ),
    raw(
      `WITH d AS (SELECT generate_series(?::date, ?::date, interval '1 day')::date AS day)
       SELECT d.day,
         COALESCE((SELECT sum(i.total_amount) FROM bill_items i JOIN bills b ON b.id = i.bill_id
                    WHERE i.facility_id = :f AND i.status = 'active' AND b.status <> 'cancelled'
                      AND ${localDay('i.posted_at')} = d.day), 0) AS billed,
         COALESCE((SELECT sum(i.patient_amount) FROM bill_items i JOIN bills b ON b.id = i.bill_id
                    WHERE i.facility_id = :f AND i.status = 'active' AND b.status <> 'cancelled'
                      AND ${localDay('i.posted_at')} = d.day), 0) AS patient_billed,
         COALESCE((SELECT sum(amount) FROM payments WHERE facility_id = :f AND status = 'completed'
                      AND ${localDay('received_at')} = d.day), 0) AS collected,
         COALESCE((SELECT sum(amount) FROM refunds WHERE facility_id = :f AND kind = 'refund' AND status = 'paid'
                      AND ${localDay('paid_at')} = d.day), 0) AS refunded,
         COALESCE((SELECT sum(amount) FROM waivers WHERE facility_id = :f AND status = 'approved'
                      AND ${localDay('decided_at')} = d.day), 0) AS waived,
         COALESCE((SELECT sum(amount) FROM refunds WHERE facility_id = :f AND kind = 'credit_note' AND status = 'approved'
                      AND ${localDay('decided_at')} = d.day), 0) AS credited
       FROM d ORDER BY d.day`
        .replace(/:f/g, '?')
        .replace(/\s+/g, ' '),
      // generate_series bounds, then the facility for each of the six sub-queries.
      [...range, f, f, f, f, f, f],
    ),
    raw(
      `SELECT s.id, u.full_name AS cashier, s.status, s.opened_at, s.closed_at, s.opening_float,
              s.system_totals, s.declared, s.variance
       FROM cashier_shifts s JOIN users u ON u.id = s.cashier_id
       WHERE s.facility_id = ? AND ${localDay('s.opened_at')} BETWEEN ? AND ?
       ORDER BY s.opened_at`,
      [f, ...range],
    ),
  ]);

  const methods = ['cash', 'mpesa', 'card', 'bank'].map((m) => {
    const r = received.find((x) => x.method === m);
    const o = refunded.find((x) => x.method === m);
    return {
      method: m,
      payments: r?.n ?? 0,
      received: money(r?.total),
      refunded: money(o?.total),
      net: fromCents(toCents(r?.total ?? 0) - toCents(o?.total ?? 0)),
    };
  });
  const dayRows = days.map((d) => ({
    day: ymd(d.day),
    billed: money(d.billed),
    patientBilled: money(d.patient_billed),
    collected: money(d.collected),
    refunded: money(d.refunded),
    netCollected: fromCents(toCents(d.collected) - toCents(d.refunded)),
    waived: money(d.waived),
    credited: money(d.credited),
  }));
  const sum = (rows, k) => fromCents(rows.reduce((s, r) => s + toCents(r[k]), 0));
  const sumShift = (obj, pick) =>
    obj ? fromCents(Object.values(obj).reduce((s, v) => s + toCents(pick(v) ?? 0), 0)) : null;

  return {
    from: q.from,
    to: q.to,
    facilityId: f,
    totals: {
      billed: sum(dayRows, 'billed'),
      payerShare: sum(departments, 'payer'),
      patientShare: money(patientShare[0]?.billed),
      collected: sum(dayRows, 'collected'),
      refunded: sum(dayRows, 'refunded'),
      netCollected: sum(dayRows, 'netCollected'),
      waived: sum(dayRows, 'waived'),
      credited: sum(dayRows, 'credited'),
    },
    days: dayRows,
    departments: departments.map((d) => ({
      department: d.name,
      lines: d.lines,
      billed: money(d.billed),
      payerShare: money(d.payer),
      patientShare: money(d.patient),
    })),
    payers: [
      ...payers.map((p) => ({ payer: p.name, scheme: p.scheme, bills: p.bills, billed: money(p.billed) })),
      {
        payer: 'Patients (out of pocket)',
        scheme: null,
        bills: patientShare[0]?.bills ?? 0,
        billed: money(patientShare[0]?.billed),
      },
    ],
    methods,
    cashiers: cashiers.map((s) => ({
      shiftId: s.id,
      cashier: s.cashier,
      status: s.status,
      openedAt: s.opened_at,
      closedAt: s.closed_at,
      openingFloat: money(s.opening_float),
      expected: sumShift(s.system_totals, (v) => v.expected),
      declared: sumShift(s.declared, (v) => v),
      variance: sumShift(s.variance, (v) => v),
    })),
  };
}

/** Bucket for an age in days. */
export const bucketOf = (days) => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');

/**
 * Debtor ageing as of today: every bill the patient still owes on, aged from the day the bill
 * opened; plus the insurer share billed to each payer, aged the same way (claims arrive in
 * Phase 7 and will take settled amounts off).
 * @param {Deps} deps @param {AuthContext} auth @param {{bucket?: string}} [q]
 */
export async function debtorAgeing({ db }, auth, q = {}) {
  const f = facilityOf(auth);
  const today = todayNairobi();
  const age = `(?::date - ${localDay('b.opened_at')})`;
  const { rows } = await db.raw(
    `SELECT b.id, b.bill_number, ${localDay('b.opened_at')} AS opened_on, ${age}::int AS age_days,
            b.total_amount, b.patient_amount, b.paid_amount, b.waived_amount, b.credited_amount, b.balance,
            p.mrn, p.first_name, p.middle_name, p.last_name, p.is_restricted, b.customer_name,
            s.name AS scheme_name,
            (SELECT max(received_at) FROM payments WHERE bill_id = b.id AND status = 'completed') AS last_payment_at
     FROM bills b
     LEFT JOIN patients p ON p.id = b.patient_id
     LEFT JOIN patient_payer_schemes ps ON ps.id = b.patient_payer_scheme_id
     LEFT JOIN schemes s ON s.id = ps.scheme_id
     WHERE b.facility_id = ? AND b.status <> 'cancelled' AND b.balance > 0
     ORDER BY b.opened_at, b.bill_number
     LIMIT 5000`,
    [today, f],
  );
  const { rows: payerRows } = await db.raw(
    `SELECT py.name AS payer, ${age}::int AS age_days, sum(b.payer_amount) AS amount, count(*)::int AS bills
     FROM bills b
     JOIN patient_payer_schemes ps ON ps.id = b.patient_payer_scheme_id
     JOIN schemes s ON s.id = ps.scheme_id
     JOIN payers py ON py.id = s.payer_id
     WHERE b.facility_id = ? AND b.status <> 'cancelled' AND b.payer_amount > 0
     GROUP BY 1, 2`,
    [today, f],
  );

  const BUCKETS = ['0-30', '31-60', '61-90', '90+'];
  const empty = () => Object.fromEntries(BUCKETS.map((k) => [k, 0]));
  const bills = rows.map((r) => {
    const restricted = r.is_restricted;
    const name = r.first_name
      ? [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ')
      : (r.customer_name ?? '—');
    return {
      billId: r.id,
      billNumber: r.bill_number,
      patient: restricted ? 'Restricted patient' : name,
      mrn: r.mrn ?? null,
      scheme: r.scheme_name ?? 'Cash',
      openedOn: ymd(r.opened_on),
      ageDays: r.age_days,
      bucket: bucketOf(r.age_days),
      patientShare: money(r.patient_amount),
      paid: money(r.paid_amount),
      waivedOrCredited: fromCents(toCents(r.waived_amount) + toCents(r.credited_amount)),
      balance: money(r.balance),
      lastPaymentAt: r.last_payment_at,
    };
  });

  const summary = empty();
  const counts = empty();
  for (const b of bills) {
    summary[b.bucket] += toCents(b.balance);
    counts[b.bucket] += 1;
  }
  const payerMap = new Map();
  for (const r of payerRows) {
    const p = payerMap.get(r.payer) ?? { payer: r.payer, bills: 0, ...empty(), total: 0 };
    const k = bucketOf(r.age_days);
    p[k] += toCents(r.amount);
    p.total += toCents(r.amount);
    p.bills += r.bills;
    payerMap.set(r.payer, p);
  }
  const asMoney = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fromCents(v)]));

  return {
    asOf: today,
    buckets: BUCKETS.map((k) => ({ bucket: k, bills: counts[k], amount: fromCents(summary[k]) })),
    total: fromCents(Object.values(summary).reduce((a, b) => a + b, 0)),
    bills: q.bucket ? bills.filter((b) => b.bucket === q.bucket) : bills,
    truncated: rows.length === 5000,
    payers: [...payerMap.values()]
      .sort((a, b) => b.total - a.total)
      .map((p) => ({
        payer: p.payer,
        bills: p.bills,
        ...asMoney(Object.fromEntries(BUCKETS.map((k) => [k, p[k]]))),
        total: fromCents(p.total),
      })),
  };
}

/** CSV tables for each report section: [header, rows]. */
export const REVENUE_CSV = {
  days: (r) => [
    ['Day', 'Billed', 'Patient share billed', 'Collected', 'Refunded', 'Net collected', 'Waived', 'Credited'],
    r.days.map((d) => [
      d.day,
      d.billed,
      d.patientBilled,
      d.collected,
      d.refunded,
      d.netCollected,
      d.waived,
      d.credited,
    ]),
  ],
  departments: (r) => [
    ['Department', 'Lines', 'Billed', 'Payer share', 'Patient share'],
    r.departments.map((d) => [d.department, d.lines, d.billed, d.payerShare, d.patientShare]),
  ],
  payers: (r) => [['Payer', 'Scheme', 'Bills', 'Billed'], r.payers.map((p) => [p.payer, p.scheme, p.bills, p.billed])],
  methods: (r) => [
    ['Method', 'Payments', 'Received', 'Refunded', 'Net'],
    r.methods.map((m) => [m.method, m.payments, m.received, m.refunded, m.net]),
  ],
  cashiers: (r) => [
    ['Cashier', 'Status', 'Opened', 'Closed', 'Opening float', 'Expected', 'Declared', 'Variance'],
    r.cashiers.map((c) => [
      c.cashier,
      c.status,
      c.openedAt,
      c.closedAt,
      c.openingFloat,
      c.expected,
      c.declared,
      c.variance,
    ]),
  ],
};

export const debtorsCsv = (r) => [
  [
    'Bill',
    'Patient',
    'MRN',
    'Scheme',
    'Opened',
    'Age (days)',
    'Bucket',
    'Patient share',
    'Paid',
    'Waived/credited',
    'Balance',
    'Last payment',
  ],
  r.bills.map((b) => [
    b.billNumber,
    b.patient,
    b.mrn,
    b.scheme,
    b.openedOn,
    b.ageDays,
    b.bucket,
    b.patientShare,
    b.paid,
    b.waivedOrCredited,
    b.balance,
    b.lastPaymentAt ? new Date(b.lastPaymentAt).toISOString() : '',
  ]),
];

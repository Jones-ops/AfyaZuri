import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatKES, sumAmounts, todayNairobi } from '@afyazuri/shared';
import { api, qs } from '../api.js';
import { Can } from '../auth.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner, formatDateTime } from '../components/ui.jsx';

const k = (v) => formatKES(v, { currency: false });
const shiftDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const METHOD = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank' };

/** CSV download link (only for people allowed to export). */
function Csv({ href, label = 'CSV' }) {
  return (
    <Can perm="reports.export">
      <a className="btn-secondary min-h-8 px-3 text-xs" href={href} download>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14" />
        </svg>
        {label}
      </a>
    </Can>
  );
}

function Table({ title, csv, head, rows, foot, id }) {
  return (
    <section className="card mb-4 overflow-x-auto" aria-labelledby={id}>
      <div className="flex items-center justify-between gap-2 px-4 pt-4">
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {csv}
      </div>
      {rows.length ? (
        <table className="table-base mt-2">
          <thead>
            <tr>
              {head.map(([h, right]) => (
                <th key={h} className={right ? 'text-right' : ''}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={head[j][1] ? 'text-right whitespace-nowrap tabular-nums' : ''}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {foot && (
            <tfoot>
              <tr className="font-semibold">
                {foot.map((c, j) => (
                  <td key={j} className={`px-3 py-2 ${head[j][1] ? 'text-right tabular-nums' : ''}`}>
                    {c}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      ) : (
        <EmptyState title="Nothing in this period" />
      )}
    </section>
  );
}

function Revenue() {
  const today = todayNairobi();
  const [range, setRange] = useState({ from: today, to: today });
  const q = useQuery({
    queryKey: ['report', 'revenue', range],
    queryFn: () => api.get(`/reports/revenue${qs(range)}`),
    enabled: range.from <= range.to,
  });
  const csv = (table) => `/api/v1/reports/revenue${qs({ ...range, format: 'csv', table })}`;
  const presets = [
    ['Today', today, today],
    ['Yesterday', shiftDays(today, -1), shiftDays(today, -1)],
    ['Last 7 days', shiftDays(today, -6), today],
    ['This month', `${today.slice(0, 8)}01`, today],
  ];
  const r = q.data;
  return (
    <>
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="From">
          <input
            className="input"
            type="date"
            value={range.from}
            max={today}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </Field>
        <Field label="To">
          <input
            className="input"
            type="date"
            value={range.to}
            max={today}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </Field>
        <div className="flex flex-wrap gap-1">
          {presets.map(([label, from, to]) => (
            <button
              key={label}
              type="button"
              className={range.from === from && range.to === to ? 'btn-primary min-h-9' : 'btn-secondary min-h-9'}
              onClick={() => setRange({ from, to })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {range.from > range.to ? (
        <ErrorMessage error={{ message: 'The end date is before the start date.' }} />
      ) : q.isPending ? (
        <div className="card">
          <Spinner label="Adding up the takings…" />
        </div>
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : (
        <>
          <section aria-label="Revenue totals" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Billed', r.totals.billed],
              ['Collected (net)', r.totals.netCollected],
              ['Waived + credited', sumAmounts([r.totals.waived, r.totals.credited])],
              ['Insurer share', r.totals.payerShare],
            ].map(([label, v], i) => (
              <div
                key={label}
                className="card p-3"
                style={{ animation: `az-page-in 300ms ${i * 50}ms cubic-bezier(0.22,1,0.36,1) both` }}
              >
                <div className="text-xs text-slate-600">{label}</div>
                <div className="text-lg font-semibold tabular-nums" data-testid={`total-${label}`}>
                  {formatKES(v)}
                </div>
              </div>
            ))}
          </section>

          <Table
            id="methods-h"
            title="Collections by payment method"
            csv={<Csv href={csv('methods')} />}
            head={[['Method'], ['Payments', 1], ['Received', 1], ['Refunded', 1], ['Net', 1]]}
            rows={r.methods.map((m) => [METHOD[m.method], m.payments, k(m.received), k(m.refunded), k(m.net)])}
            foot={['Total', '', k(r.totals.collected), k(r.totals.refunded), k(r.totals.netCollected)]}
          />
          <div className="grid gap-x-4 lg:grid-cols-2">
            <Table
              id="dept-h"
              title="Billed by department"
              csv={<Csv href={csv('departments')} />}
              head={[['Department'], ['Billed', 1], ['Insurer', 1], ['Patient', 1]]}
              rows={r.departments.map((d) => [d.department, k(d.billed), k(d.payerShare), k(d.patientShare)])}
              foot={['Total', k(r.totals.billed), k(r.totals.payerShare), k(r.totals.patientShare)]}
            />
            <Table
              id="payer-h"
              title="Billed by payer"
              csv={<Csv href={csv('payers')} />}
              head={[['Payer'], ['Bills', 1], ['Billed', 1]]}
              rows={r.payers.map((p) => [p.scheme ? `${p.payer} — ${p.scheme}` : p.payer, p.bills, k(p.billed)])}
              foot={['Total', '', k(r.totals.billed)]}
            />
          </div>
          <Table
            id="days-h"
            title="Day by day"
            csv={<Csv href={csv('days')} />}
            head={[['Day'], ['Billed', 1], ['Collected', 1], ['Refunded', 1], ['Waived', 1], ['Credited', 1]]}
            rows={r.days.map((d) => [d.day, k(d.billed), k(d.collected), k(d.refunded), k(d.waived), k(d.credited)])}
          />
          <Table
            id="shift-h"
            title="Cashier shifts"
            csv={<Csv href={csv('cashiers')} />}
            head={[['Cashier'], ['Opened'], ['Status'], ['Expected', 1], ['Declared', 1], ['Variance', 1]]}
            rows={r.cashiers.map((c) => [
              c.cashier,
              formatDateTime(c.openedAt),
              <Badge key="s" tone={c.status === 'open' ? 'amber' : 'slate'}>
                {c.status}
              </Badge>,
              c.expected ? k(c.expected) : '—',
              c.declared ? k(c.declared) : '—',
              c.variance ? (
                <span
                  className={Number(c.variance) < 0 ? 'text-red-700' : Number(c.variance) > 0 ? 'text-amber-800' : ''}
                >
                  {k(c.variance)}
                </span>
              ) : (
                '—'
              ),
            ])}
          />
        </>
      )}
    </>
  );
}

const BUCKET_TONE = { '0-30': 'green', '31-60': 'amber', '61-90': 'amber', '90+': 'red' };

function Debtors() {
  const [bucket, setBucket] = useState('');
  const q = useQuery({ queryKey: ['report', 'debtors'], queryFn: () => api.get('/reports/debtors') });
  if (q.isPending)
    return (
      <div className="card">
        <Spinner label="Ageing the balances…" />
      </div>
    );
  if (q.error) return <ErrorMessage error={q.error} />;
  const r = q.data;
  const bills = bucket ? r.bills.filter((b) => b.bucket === bucket) : r.bills;
  return (
    <>
      <section aria-label="Ageing buckets" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[{ bucket: '', bills: r.bills.length, amount: r.total }, ...r.buckets].map((b) => (
          <button
            key={b.bucket || 'all'}
            type="button"
            aria-pressed={bucket === b.bucket}
            onClick={() => setBucket(b.bucket)}
            className={`card card-link p-3 text-left ${bucket === b.bucket ? 'ring-2 ring-brand-600' : ''}`}
          >
            <div className="text-xs text-slate-600">{b.bucket ? `${b.bucket} days` : 'All outstanding'}</div>
            <div className="text-lg font-semibold tabular-nums">{formatKES(b.amount)}</div>
            <div className="text-xs text-slate-600">{b.bills} bills</div>
          </button>
        ))}
      </section>
      <Table
        id="debtors-h"
        title={`Patients owing${bucket ? ` (${bucket} days)` : ''} — as of ${r.asOf}`}
        csv={<Csv href={`/api/v1/reports/debtors${qs({ format: 'csv', bucket: bucket || undefined })}`} />}
        head={[['Bill'], ['Patient'], ['Scheme'], ['Opened'], ['Age', 1], ['Paid', 1], ['Balance', 1]]}
        rows={bills.map((b) => [
          <Link key="b" className="font-mono text-brand-800 hover:underline" to={`/billing/bills/${b.billId}`}>
            {b.billNumber}
          </Link>,
          <span key="p">
            {b.patient} {b.mrn && <span className="font-mono text-xs text-slate-600">{b.mrn}</span>}
          </span>,
          b.scheme,
          b.openedOn,
          <Badge key="a" tone={BUCKET_TONE[b.bucket]}>
            {b.ageDays} d
          </Badge>,
          k(b.paid),
          <strong key="bal">{k(b.balance)}</strong>,
        ])}
      />
      {r.truncated && (
        <p className="mb-4 text-xs text-slate-600">Showing the oldest 5,000 bills; export for the rest.</p>
      )}
      {r.payers.length > 0 && (
        <Table
          id="payers-ageing-h"
          title="Insurer share by age (claims arrive with the claims module)"
          head={[['Payer'], ['Bills', 1], ['0-30', 1], ['31-60', 1], ['61-90', 1], ['90+', 1], ['Total', 1]]}
          rows={r.payers.map((p) => [
            p.payer,
            p.bills,
            k(p['0-30']),
            k(p['31-60']),
            k(p['61-90']),
            k(p['90+']),
            k(p.total),
          ])}
        />
      )}
    </>
  );
}

/** Finance reports: daily revenue reconciliation and debtor ageing. */
export default function FinanceReports() {
  const [tab, setTab] = useState('revenue');
  return (
    <>
      <PageHeader title="Finance reports" description="Revenue reconciliation and who still owes the facility." />
      <div role="tablist" aria-label="Report" className="mb-4 flex gap-1">
        {[
          ['revenue', 'Daily revenue'],
          ['debtors', 'Debtor ageing'],
        ].map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'revenue' ? <Revenue /> : <Debtors />}
    </>
  );
}

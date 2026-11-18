import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatKES, todayNairobi } from '@afyazuri/shared';
import { api, qs } from '../../api.js';
import { Can } from '../../auth.jsx';
import { InventoryNav } from '../../components/inventory/common.jsx';
import { EmptyState, ErrorMessage, Field, PageHeader, Spinner } from '../../components/ui.jsx';

const k = (v) => formatKES(v, { currency: false });
const monthStart = (d) => `${d.slice(0, 8)}01`;
const LOSS = { expiry_writeoff: 'Expired, written off', stocktake: 'Stock-take variance', adjustment: 'Adjustment' };

function Csv({ href }) {
  return (
    <Can perm="reports.export">
      <a className="btn-secondary min-h-8 px-3 text-xs" href={href} download>
        Download CSV
      </a>
    </Can>
  );
}

function Consumption() {
  const today = todayNairobi();
  const [range, setRange] = useState({ from: monthStart(today), to: today });
  const q = useQuery({
    queryKey: ['report', 'consumption', range],
    queryFn: () => api.get(`/inventory/reports/consumption${qs(range)}`),
    enabled: range.from <= range.to,
  });
  return (
    <>
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="From">
          <input
            className="input"
            type="date"
            max={today}
            value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </Field>
        <Field label="To">
          <input
            className="input"
            type="date"
            max={today}
            value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </Field>
        <Csv href={`/api/v1/inventory/reports/consumption${qs({ ...range, format: 'csv' })}`} />
      </div>
      {q.isPending ? (
        <div className="card">
          <Spinner />
        </div>
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : (
        <>
          <p className="mb-3 text-sm text-slate-700">
            Used: <strong>{formatKES(q.data.totalValue)}</strong> at cost · Losses{' '}
            <strong className="text-red-700">{formatKES(String(Math.abs(Number(q.data.lossValue))))}</strong> · Gains{' '}
            {formatKES(q.data.gainValue)}
          </p>
          {q.data.departments.length === 0 && <EmptyState title="Nothing used in this period" />}
          {q.data.departments.map((d) => (
            <section
              key={d.department}
              className="card mb-4 overflow-x-auto"
              aria-label={`${d.department} consumption`}
            >
              <h2 className="flex justify-between px-4 pt-4 font-semibold">
                {d.department} <span className="tabular-nums">{formatKES(d.value)}</span>
              </h2>
              <table className="table-base mt-2">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Value at cost</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.itemId}>
                      <td>{i.item}</td>
                      <td className="text-right tabular-nums">
                        {i.quantity} {i.baseUnit}
                      </td>
                      <td className="text-right tabular-nums">{k(i.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
          {q.data.losses.length > 0 && (
            <section className="card overflow-x-auto" aria-label="Losses and gains">
              <h2 className="px-4 pt-4 font-semibold">Losses and gains</h2>
              <table className="table-base mt-2">
                <thead>
                  <tr>
                    <th>Store</th>
                    <th>Why</th>
                    <th>Item</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.losses.map((l, i) => (
                    <tr key={i}>
                      <td>{l.store}</td>
                      <td>{LOSS[l.type] ?? l.type}</td>
                      <td>{l.item}</td>
                      <td className="text-right tabular-nums">{l.quantity}</td>
                      <td className={`text-right tabular-nums ${Number(l.value) < 0 ? 'text-red-700' : ''}`}>
                        {k(l.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </>
  );
}

function Valuation() {
  const q = useQuery({ queryKey: ['report', 'valuation'], queryFn: () => api.get('/inventory/reports/valuation') });
  if (q.isPending)
    return (
      <div className="card">
        <Spinner />
      </div>
    );
  if (q.error) return <ErrorMessage error={q.error} />;
  const v = q.data;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="text-sm text-slate-700">
          Stock on hand: <strong>{formatKES(v.totalValue)}</strong> at weighted average cost (as of {v.asOf}) · Expired,
          not yet written off: <strong className="text-red-700">{formatKES(v.expiredValue)}</strong>
        </p>
        <Csv href="/api/v1/inventory/reports/valuation?format=csv" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[
          ['By store', v.byStore, 'store'],
          ['By category', v.byCategory, 'category'],
        ].map(([title, rows, key]) => (
          <section key={title} className="card overflow-x-auto" aria-label={title}>
            <h2 className="px-4 pt-4 font-semibold">{title}</h2>
            <table className="table-base mt-2">
              <thead>
                <tr>
                  <th>{key === 'store' ? 'Store' : 'Category'}</th>
                  <th className="text-right">Items</th>
                  <th className="text-right">Value</th>
                  <th className="text-right">Expired</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r[key]}>
                    <td>{r[key]}</td>
                    <td className="text-right tabular-nums">{r.items}</td>
                    <td className="text-right tabular-nums">{k(r.value)}</td>
                    <td className="text-right tabular-nums">{Number(r.expiredValue) ? k(r.expiredValue) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </>
  );
}

/** Consumption by department and item; stock valuation at weighted average cost. */
export default function InventoryReports() {
  const [tab, setTab] = useState('consumption');
  return (
    <>
      <PageHeader
        title="Stock reports"
        description="What each department used, what was lost, and what the stock is worth."
      />
      <InventoryNav />
      <div role="tablist" aria-label="Report" className="mb-4 flex gap-1">
        {[
          ['consumption', 'Consumption'],
          ['valuation', 'Valuation'],
        ].map(([t, l]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab(t)}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'consumption' ? <Consumption /> : <Valuation />}
    </>
  );
}

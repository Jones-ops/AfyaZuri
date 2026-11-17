import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PAYMENT_METHODS, formatKES, fromCents, toCents } from '@afyazuri/shared';
import { api } from '../api.js';
import { Alert, Badge, ErrorMessage, Field, PageHeader, Spinner, formatDateTime } from '../components/ui.jsx';

const LABEL = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank' };

/** Cashier desk: open, monitor and close a shift; jump to patients waiting to pay. */
export default function Cashier() {
  const shift = useQuery({ queryKey: ['shift'], queryFn: () => api.get('/shifts/current'), refetchInterval: 15_000 });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api.get('/queues') });
  const unmatched = useQuery({ queryKey: ['mpesa-unmatched'], queryFn: () => api.get('/mpesa-unmatched') });
  const cashierQueues = (queues.data?.data ?? []).filter((q) => q.type === 'cashier');

  return (
    <>
      <PageHeader
        title="Cashier desk"
        description="Open your shift, take payments from the cashier queue, and close the shift with your count."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),20rem]">
        {shift.isPending ? <Spinner /> : shift.data.shift ? <OpenShift shift={shift.data.shift} /> : <StartShift />}
        <aside className="space-y-3">
          {cashierQueues.map((q) => (
            <Link key={q.id} to={`/opd/queues/${q.id}`} className="card block p-4 hover:border-brand-600">
              <div className="font-semibold">{q.name}</div>
              <div className="text-sm text-slate-600">{q.waiting} waiting to pay</div>
            </Link>
          ))}
          <Link to="/billing" className="card block p-4 hover:border-brand-600">
            <div className="font-semibold">Find a bill</div>
            <div className="text-sm text-slate-600">By bill number, MRN or name</div>
          </Link>
          {unmatched.data?.data.length > 0 && (
            <Alert kind="warn">{unmatched.data.data.length} Paybill payment(s) need matching to a bill.</Alert>
          )}
        </aside>
      </div>
    </>
  );
}

function StartShift() {
  const qc = useQueryClient();
  const [float, setFloat] = useState('0');
  const m = useMutation({
    mutationFn: () => api.post('/shifts', { openingFloat: float }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shift'] }),
  });
  return (
    <form
      className="card space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <h2 className="font-semibold">Start a shift</h2>
      <Field label="Opening float (cash in the drawer, KES)">
        <input
          className="input max-w-xs text-lg"
          inputMode="decimal"
          value={float}
          onChange={(e) => setFloat(e.target.value)}
        />
      </Field>
      <ErrorMessage error={m.error} />
      <button className="btn-primary" disabled={m.isPending}>
        Open shift
      </button>
    </form>
  );
}

function OpenShift({ shift }) {
  const qc = useQueryClient();
  const [declared, setDeclared] = useState(Object.fromEntries(PAYMENT_METHODS.map((m) => [m, ''])));
  const [notes, setNotes] = useState('');
  const close = useMutation({
    mutationFn: () =>
      api.post('/shifts/current/close', {
        declared: Object.fromEntries(PAYMENT_METHODS.map((m) => [m, declared[m] || '0'])),
        notes,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shift'] }),
  });
  const t = shift.systemTotals;
  const variance = (m) => {
    try {
      return declared[m] === '' ? null : toCents(declared[m].replace(/,/g, '')) - toCents(t[m].expected);
    } catch {
      return null;
    }
  };

  return (
    <section className="card p-4" aria-label="Current shift">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Shift open <Badge tone="green">since {formatDateTime(shift.openedAt)}</Badge>
        </h2>
        <span className="text-sm text-slate-600">Opening float {formatKES(shift.openingFloat)}</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (window.confirm('Close this shift? You will not be able to take more payments on it.')) close.mutate();
        }}
      >
        <table className="table-base">
          <thead>
            <tr>
              <th>Method</th>
              <th className="text-right">Payments</th>
              <th className="text-right">Expected in hand</th>
              <th>You counted</th>
              <th className="text-right">Difference</th>
            </tr>
          </thead>
          <tbody>
            {PAYMENT_METHODS.map((m) => {
              const v = variance(m);
              return (
                <tr key={m}>
                  <td>{LABEL[m]}</td>
                  <td className="text-right">
                    {t[m].count} · {formatKES(t[m].received, { currency: false })}
                  </td>
                  <td className="text-right font-medium">{formatKES(t[m].expected, { currency: false })}</td>
                  <td>
                    <input
                      className="input w-32"
                      aria-label={`${LABEL[m]} counted`}
                      inputMode="decimal"
                      value={declared[m]}
                      onChange={(e) => setDeclared({ ...declared, [m]: e.target.value })}
                    />
                  </td>
                  <td
                    className={`text-right ${v === null ? '' : v === 0 ? 'text-emerald-700' : 'font-semibold text-red-700'}`}
                  >
                    {v === null ? '—' : formatKES(fromCents(v), { currency: false })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr,auto] sm:items-end">
          <Field label="Notes (explain any difference)">
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <button className="btn-danger" disabled={close.isPending}>
            Close shift
          </button>
        </div>
        <ErrorMessage error={close.error} />
      </form>
    </section>
  );
}

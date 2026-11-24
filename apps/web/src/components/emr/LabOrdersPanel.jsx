import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { LAB_PRIORITIES } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Can } from '../../auth.jsx';
import { Badge, ErrorMessage, Field, formatDateTime } from '../ui.jsx';

export const LAB_STATUS_TONE = {
  ordered: 'slate',
  collected: 'blue',
  received: 'blue',
  resulted: 'amber',
  verified: 'green',
  cancelled: 'slate',
};

function OrderForm({ encounterId, onDone }) {
  const catalogue = useQuery({
    queryKey: ['lab', 'orderable'],
    queryFn: () => api.get('/lab/orderable-tests'),
    staleTime: 300_000,
  });
  const [picked, setPicked] = useState([]);
  const [priority, setPriority] = useState('routine');
  const [notes, setNotes] = useState('');
  const key = useRef(crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api.post(
        `/encounters/${encounterId}/lab-orders`,
        { tests: picked, priority, clinicalNotes: notes || null, clientId: key.current },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: () => {
      key.current = crypto.randomUUID();
      setPicked([]);
      setNotes('');
      onDone();
    },
  });
  const sections = new Map();
  for (const t of catalogue.data?.data ?? []) sections.set(t.section, [...(sections.get(t.section) ?? []), t]);
  return (
    <div className="space-y-3 border-t border-slate-100 pt-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[...sections.entries()].map(([section, tests]) => (
          <fieldset key={section} className="rounded-md border border-slate-200 p-2">
            <legend className="px-1 text-xs font-semibold tracking-wide text-slate-600 uppercase">{section}</legend>
            {tests.map((t) => (
              <label key={t.id} className="flex items-center gap-2 py-0.5 text-sm">
                <input
                  type="checkbox"
                  checked={picked.includes(t.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id)))}
                />
                {t.name}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="Priority">
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {LAB_PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field label="Clinical notes for the lab">
          <input
            className="input"
            value={notes}
            placeholder="e.g. fever 3 days, on no antimalarials"
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      </div>
      <ErrorMessage error={m.error} />
      <button className="btn-primary" disabled={!picked.length || m.isPending} onClick={() => m.mutate()}>
        Order {picked.length || ''} test{picked.length === 1 ? '' : 's'}
      </button>
    </div>
  );
}

/** Lab orders in this visit, with each test's progress; prescribers can order more. */
export default function LabOrdersPanel({ encounterId }) {
  const qc = useQueryClient();
  const [ordering, setOrdering] = useState(false);
  const list = useQuery({
    queryKey: ['lab-orders', encounterId],
    queryFn: () => api.get(`/encounters/${encounterId}/lab-orders`),
  });
  return (
    <section className="card p-4" aria-labelledby="lab-h">
      <div className="flex items-center justify-between">
        <h2 id="lab-h" className="font-semibold">
          Lab tests
        </h2>
        <Can perm="orders.lab.create">
          <button className="btn-secondary min-h-9" onClick={() => setOrdering((v) => !v)}>
            {ordering ? 'Close' : 'Order tests'}
          </button>
        </Can>
      </div>
      <ErrorMessage error={list.error} />
      {(list.data?.data ?? []).map((o) => (
        <div key={o.id} className="mt-3 rounded-md border border-slate-200 p-3 text-sm">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-mono">{o.orderNumber}</span>
            {o.priority !== 'routine' && <Badge tone="red">{o.priority}</Badge>}
            <span className="text-xs text-slate-600">
              {o.orderedBy}, {formatDateTime(o.orderedAt)}
            </span>
          </div>
          <ul className="flex flex-wrap gap-2">
            {o.items.map((i) => (
              <li key={i.id}>
                <Badge tone={LAB_STATUS_TONE[i.status]}>
                  {i.name}: {i.status}
                  {i.overdue ? ' (overdue)' : ''}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {list.data && list.data.data.length === 0 && !ordering && (
        <p className="mt-2 text-sm text-slate-600">No lab tests in this visit.</p>
      )}
      {ordering && (
        <OrderForm
          encounterId={encounterId}
          onDone={() => {
            setOrdering(false);
            qc.invalidateQueries({ queryKey: ['lab-orders', encounterId] });
          }}
        />
      )}
    </section>
  );
}

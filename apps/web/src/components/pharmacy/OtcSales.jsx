import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { formatKES } from '@afyazuri/shared';
import { api, qs } from '../../api.js';
import { Can } from '../../auth.jsx';
import { ItemPicker } from '../inventory/common.jsx';
import { Alert, Badge, EmptyState, ErrorMessage, Field, Spinner, formatDateTime } from '../ui.jsx';

const TONE = { awaiting_payment: 'amber', completed: 'green', cancelled: 'slate' };
const sellable = (i) =>
  i.category === 'consumable' || (i.category === 'drug' && i.drug?.otcAllowed && !i.drug?.controlled);

function NewSale({ storeId, onDone }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [lines, setLines] = useState([]);
  const [refused, setRefused] = useState(null);
  const key = useRef(crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api.post(
        '/otc-sales',
        {
          storeId,
          customerName: name,
          customerPhone: phone || null,
          lines: lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity })),
        },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: (sale) => {
      key.current = crypto.randomUUID();
      setName('');
      setPhone('');
      setLines([]);
      onDone(sale);
    },
  });
  return (
    <form
      className="card mb-4 space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <h2 className="font-semibold">New walk-in sale</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Phone (optional)">
          <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      {lines.map((l) => (
        <div key={l.item.id} className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 font-medium">{l.item.name}</div>
          <Field label={`Quantity (${l.item.baseUnit}s)`}>
            <input
              className="input w-28"
              inputMode="decimal"
              value={l.quantity}
              onChange={(e) =>
                setLines((ls) => ls.map((x) => (x.item.id === l.item.id ? { ...x, quantity: e.target.value } : x)))
              }
            />
          </Field>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setLines((ls) => ls.filter((x) => x.item.id !== l.item.id))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="max-w-md">
        <ItemPicker
          label="Add an item"
          onPick={(item) => {
            if (!sellable(item))
              return setRefused(`${item.name} needs a prescription; it cannot be sold over the counter.`);
            setRefused(null);
            if (!lines.some((l) => l.item.id === item.id)) setLines((ls) => [...ls, { item, quantity: '1' }]);
          }}
        />
      </div>
      {refused && <Alert kind="warn">{refused}</Alert>}
      <ErrorMessage error={m.error} />
      <button className="btn-primary" disabled={m.isPending || !lines.length || name.trim().length < 2 || !storeId}>
        Ring up sale
      </button>
      <p className="text-xs text-slate-600">
        The customer pays at the cashier; hand the items over once the bill shows paid.
      </p>
    </form>
  );
}

/** Walk-in (over-the-counter) sales: ring up, customer pays at the cashier, hand over. */
export default function OtcSales({ storeId }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('awaiting_payment');
  const [creating, setCreating] = useState(false);
  const [latest, setLatest] = useState(null);
  const list = useQuery({
    queryKey: ['otc-sales', status],
    queryFn: () => api.get(`/otc-sales${qs({ status })}`),
    refetchInterval: status === 'awaiting_payment' ? 15_000 : false,
  });
  const act = useMutation({
    mutationFn: ({ id, path, body }) => api.post(`/otc-sales/${id}/${path}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['otc-sales'] }),
  });
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Sales" className="flex gap-1">
          {[
            ['awaiting_payment', 'Awaiting payment'],
            ['completed', 'Handed over'],
            ['cancelled', 'Cancelled'],
          ].map(([s, l]) => (
            <button
              key={s}
              role="tab"
              aria-selected={status === s}
              className={status === s ? 'btn-primary min-h-9' : 'btn-secondary min-h-9'}
              onClick={() => setStatus(s)}
            >
              {l}
            </button>
          ))}
        </div>
        <Can perm="pharmacy.otc.sell">
          <button className="btn-primary ml-auto min-h-9" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Close' : 'New walk-in sale'}
          </button>
        </Can>
      </div>
      {creating && (
        <NewSale
          storeId={storeId}
          onDone={(sale) => {
            setCreating(false);
            setLatest(sale);
            setStatus('awaiting_payment');
            qc.invalidateQueries({ queryKey: ['otc-sales'] });
          }}
        />
      )}
      {latest && (
        <div className="mb-3">
          <Alert kind="info">
            {latest.saleNumber} for {latest.customerName}: {formatKES(latest.total)}. Send the customer to the cashier
            with bill <strong>{latest.billNumber}</strong>.
          </Alert>
        </div>
      )}
      <section className="card" aria-label="Walk-in sales">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <ErrorMessage error={list.error} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No sales here" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="font-mono text-sm">{s.saleNumber}</span>
                <span className="font-medium">{s.customerName}</span>
                <Badge tone={TONE[s.status]}>
                  {s.status === 'awaiting_payment' ? (s.paid ? 'paid — hand over' : 'awaiting payment') : s.status}
                </Badge>
                <span className="text-sm tabular-nums">{formatKES(s.total)}</span>
                <span className="font-mono text-xs text-slate-600">{s.billNumber}</span>
                <span className="text-xs text-slate-500">{formatDateTime(s.createdAt)}</span>
                {s.status === 'awaiting_payment' && (
                  <Can perm="pharmacy.otc.sell">
                    <span className="ml-auto flex gap-2">
                      <button
                        className="btn-primary min-h-9"
                        disabled={!s.paid || act.isPending}
                        title={s.paid ? '' : 'Not paid yet'}
                        onClick={() => act.mutate({ id: s.id, path: 'hand-over' })}
                      >
                        Hand over
                      </button>
                      <button
                        className="btn-secondary min-h-9"
                        disabled={s.paid || act.isPending}
                        onClick={() => {
                          const reason = window.prompt('Why cancel this sale?');
                          if (reason) act.mutate({ id: s.id, path: 'cancel', body: { reason } });
                        }}
                      >
                        Cancel
                      </button>
                    </span>
                  </Can>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ErrorMessage error={act.error} />
    </>
  );
}

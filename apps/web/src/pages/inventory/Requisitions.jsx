import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, qs } from '../../api.js';
import { Can, useAuth } from '../../auth.jsx';
import { InventoryNav, ItemPicker, StoreSelect, useStores } from '../../components/inventory/common.jsx';
import {
  Alert,
  Badge,
  EmptyState,
  ErrorMessage,
  Field,
  PageHeader,
  Spinner,
  formatDateTime,
} from '../../components/ui.jsx';

const TONE = {
  requested: 'amber',
  approved: 'blue',
  issued: 'teal',
  received: 'green',
  rejected: 'red',
  cancelled: 'slate',
};

function NewRequisition({ onDone }) {
  const stores = useStores();
  const [fromStoreId, setFrom] = useState(null);
  const [toStoreId, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);
  const key = useRef(crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api.post(
        '/requisitions',
        {
          fromStoreId,
          toStoreId: toStoreId || stores.data?.data.find((s) => s.type === 'main')?.id,
          notes: notes || null,
          lines: lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity })),
        },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      setLines([]);
      onDone(r);
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
      <h2 className="font-semibold">New requisition</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <StoreSelect value={fromStoreId} onChange={setFrom} label="For store (yours)" />
        <Field label="Request from">
          <select className="input" value={toStoreId} onChange={(e) => setTo(e.target.value)}>
            {(stores.data?.data ?? [])
              .filter((s) => s.active && s.id !== fromStoreId)
              .sort((a, b) => (a.type === 'main' ? -1 : b.type === 'main' ? 1 : 0))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      {lines.map((l) => (
        <div key={l.item.id} className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 font-medium">{l.item.name}</div>
          <Field label={`Quantity (${l.item.baseUnit}s)`}>
            <input
              className="input w-32"
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
          onPick={(item) =>
            !lines.some((l) => l.item.id === item.id) && setLines((ls) => [...ls, { item, quantity: '' }])
          }
        />
      </div>
      <Field label="Notes (optional)">
        <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorMessage error={m.error} />
      <button className="btn-primary" disabled={m.isPending || !lines.length}>
        Send requisition
      </button>
    </form>
  );
}

function Detail({ id }) {
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const r = useQuery({ queryKey: ['requisition', id], queryFn: () => api.get(`/requisitions/${id}`) });
  const [cuts, setCuts] = useState({});
  const [got, setGot] = useState({});
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['requisition', id] });
    qc.invalidateQueries({ queryKey: ['requisitions'] });
    qc.invalidateQueries({ queryKey: ['stock'] });
  };
  const act = useMutation({
    mutationFn: ({ path, body }) => api.post(`/requisitions/${id}/${path}`, body),
    onSuccess: refresh,
  });
  if (r.isPending) return <Spinner rows={2} />;
  if (r.error) return <ErrorMessage error={r.error} />;
  const d = r.data;
  const mine = d.requestedById === me.user.id;
  return (
    <div className="space-y-3 border-t border-slate-100 bg-slate-50/50 p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-600">
            <th className="text-left">Item</th>
            <th className="text-right">Requested</th>
            <th className="text-right">Approved</th>
            <th className="text-right">Issued</th>
            <th className="text-right">Received</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {l.name} <span className="text-xs text-slate-600">({l.baseUnit})</span>
              </td>
              <td className="text-right tabular-nums">{l.requestedQty}</td>
              <td className="text-right tabular-nums">
                {d.status === 'requested' && can('inventory.requisition.approve') && !mine ? (
                  <input
                    aria-label={`Approve quantity of ${l.name}`}
                    className="input ml-auto min-h-8 w-24 text-right"
                    inputMode="decimal"
                    value={cuts[l.itemId] ?? l.requestedQty}
                    onChange={(e) => setCuts({ ...cuts, [l.itemId]: e.target.value })}
                  />
                ) : (
                  (l.approvedQty ?? '—')
                )}
              </td>
              <td className="text-right tabular-nums">{d.issuedAt ? l.issuedQty : '—'}</td>
              <td className="text-right tabular-nums">{d.receivedAt ? l.receivedQty : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.decisionNote && (
        <p className="text-sm text-slate-700">
          Note from {d.decidedBy}: “{d.decisionNote}”
        </p>
      )}

      {d.status === 'issued' && can('inventory.receive') && (
        <div className="card p-3">
          <h3 className="mb-2 text-sm font-semibold">What arrived (count each batch)</h3>
          {d.issued.map((x) => {
            const v = got[x.id] ?? { receivedQty: x.quantity, varianceReason: '' };
            const short = Number(v.receivedQty) < Number(x.quantity);
            return (
              <div key={x.id} className="mb-2 grid gap-2 sm:grid-cols-[2fr_1fr_2fr] sm:items-end">
                <div className="text-sm">
                  {x.name} <span className="font-mono text-xs">{x.batchNumber}</span>{' '}
                  <span className="text-xs text-slate-600">issued {x.quantity}</span>
                </div>
                <Field label="Received">
                  <input
                    className="input"
                    inputMode="decimal"
                    value={v.receivedQty}
                    onChange={(e) => setGot({ ...got, [x.id]: { ...v, receivedQty: e.target.value } })}
                  />
                </Field>
                {short ? (
                  <Field label="Why less?">
                    <input
                      className="input"
                      value={v.varianceReason}
                      onChange={(e) => setGot({ ...got, [x.id]: { ...v, varianceReason: e.target.value } })}
                    />
                  </Field>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
          <button
            className="btn-primary min-h-9"
            disabled={act.isPending}
            onClick={() =>
              act.mutate({
                path: 'receive',
                body: {
                  lines: d.issued.map((x) => {
                    const v = got[x.id] ?? { receivedQty: x.quantity };
                    return { issueLineId: x.id, receivedQty: v.receivedQty, varianceReason: v.varianceReason || null };
                  }),
                },
              })
            }
          >
            Confirm receipt
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {d.status === 'requested' && (
          <Can perm="inventory.requisition.approve">
            {mine ? (
              <p className="text-xs text-slate-600">Someone else must approve your requisition.</p>
            ) : (
              <>
                <button
                  className="btn-primary min-h-9"
                  disabled={act.isPending}
                  onClick={() =>
                    act.mutate({
                      path: 'decision',
                      body: {
                        approve: true,
                        lines: Object.entries(cuts).map(([itemId, approvedQty]) => ({ itemId, approvedQty })),
                      },
                    })
                  }
                >
                  Approve
                </button>
                <button
                  className="btn-secondary min-h-9"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ path: 'decision', body: { approve: false } })}
                >
                  Reject
                </button>
              </>
            )}
          </Can>
        )}
        {d.status === 'approved' && (
          <Can perm="inventory.issue">
            <button
              className="btn-primary min-h-9"
              disabled={act.isPending}
              onClick={() => act.mutate({ path: 'issue' })}
            >
              Issue stock (earliest expiry first)
            </button>
          </Can>
        )}
        {['requested', 'approved'].includes(d.status) && (
          <Can perm="inventory.requisition.create">
            <button
              className="btn-secondary min-h-9"
              disabled={act.isPending}
              onClick={() => act.mutate({ path: 'cancel' })}
            >
              Cancel requisition
            </button>
          </Can>
        )}
      </div>
      <ErrorMessage error={act.error} />
      {d.issued.some((x) => x.varianceReason) && (
        <Alert kind="warn">
          Variances:{' '}
          {d.issued
            .filter((x) => x.varianceReason)
            .map((x) => `${x.name} ${x.batchNumber}: ${x.receivedQty} of ${x.quantity} — ${x.varianceReason}`)
            .join('; ')}
        </Alert>
      )}
    </div>
  );
}

/** Internal requisitions between stores: request → approve → issue → receive. */
export default function Requisitions() {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['requisitions', status],
    queryFn: () => api.get(`/requisitions${qs({ status: status || undefined })}`),
  });
  return (
    <>
      <PageHeader
        title="Requisitions"
        description="Wards, pharmacy and lab ask the main store for stock. Someone else approves; any shortfall on arrival is recorded."
        actions={
          <Can perm="inventory.requisition.create">
            <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
              {creating ? 'Close' : 'New requisition'}
            </button>
          </Can>
        }
      />
      <InventoryNav />
      {creating && (
        <NewRequisition
          onDone={(r) => {
            setCreating(false);
            setOpen(r.id);
            list.refetch();
          }}
        />
      )}
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Status">
        {['', 'requested', 'approved', 'issued', 'received'].map((s) => (
          <button
            key={s || 'all'}
            aria-pressed={status === s}
            className={status === s ? 'btn-primary min-h-8 px-3' : 'btn-secondary min-h-8 px-3'}
            onClick={() => setStatus(s)}
          >
            {s || 'All'}
          </button>
        ))}
      </div>
      <section className="card" aria-label="Requisitions">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <ErrorMessage error={list.error} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No requisitions" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.data.map((r) => (
              <li key={r.id}>
                <button
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-brand-50/40"
                  aria-expanded={open === r.id}
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                >
                  <span className="font-mono text-sm">{r.reqNumber}</span>
                  <Badge tone={TONE[r.status]}>{r.status}</Badge>
                  <span className="text-sm">
                    {r.fromStore} ← {r.toStore}
                  </span>
                  <span className="ml-auto text-xs text-slate-600">
                    {r.requestedBy}, {formatDateTime(r.requestedAt)}
                  </span>
                </button>
                {open === r.id && <Detail id={r.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

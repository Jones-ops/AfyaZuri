import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatKES } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Can } from '../../auth.jsx';
import { InventoryNav, ItemPicker, StoreSelect } from '../../components/inventory/common.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner, formatDateTime } from '../../components/ui.jsx';

const TONE = { draft: 'slate', sent: 'blue', partially_received: 'amber', received: 'green', cancelled: 'red' };

function NewOrder({ onDone }) {
  const [storeId, setStoreId] = useState(null);
  const [supplierId, setSupplierId] = useState('');
  const [lines, setLines] = useState([]);
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get('/suppliers') });
  const m = useMutation({
    mutationFn: () =>
      api.post('/purchase-orders', {
        storeId,
        supplierId,
        lines: lines.map((l) => ({ itemId: l.item.id, quantity: l.quantity, unitCost: l.unitCost })),
      }),
    onSuccess: (po) => {
      setLines([]);
      onDone(po);
    },
  });
  const set = (id, patch) => setLines((ls) => ls.map((l) => (l.item.id === id ? { ...l, ...patch } : l)));
  return (
    <form
      className="card mb-4 space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <h2 className="font-semibold">New purchase order</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <StoreSelect value={storeId} onChange={setStoreId} label="Deliver to" />
        <Field label="Supplier">
          <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
            <option value="">Choose…</option>
            {(suppliers.data?.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {lines.map((l) => (
        <div key={l.item.id} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
          <div className="font-medium">
            {l.item.name} <span className="text-xs text-slate-600">per {l.item.baseUnit}</span>
          </div>
          <Field label="Quantity">
            <input
              className="input"
              inputMode="decimal"
              value={l.quantity}
              onChange={(e) => set(l.item.id, { quantity: e.target.value })}
            />
          </Field>
          <Field label="Unit cost (KES)">
            <input
              className="input"
              inputMode="decimal"
              value={l.unitCost}
              onChange={(e) => set(l.item.id, { unitCost: e.target.value })}
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
            !lines.some((l) => l.item.id === item.id) &&
            setLines((ls) => [...ls, { item, quantity: '', unitCost: Number(item.averageCost).toFixed(2) }])
          }
        />
      </div>
      <ErrorMessage error={m.error} />
      <button className="btn-primary" disabled={m.isPending || !lines.length || !supplierId}>
        Create order
      </button>
    </form>
  );
}

function OrderDetail({ id }) {
  const qc = useQueryClient();
  const po = useQuery({ queryKey: ['purchase-order', id], queryFn: () => api.get(`/purchase-orders/${id}`) });
  const act = useMutation({
    mutationFn: (what) => api.post(`/purchase-orders/${id}/${what}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['purchase-order'] }) && qc.invalidateQueries({ queryKey: ['purchase-orders'] }),
  });
  if (po.isPending) return <Spinner rows={2} />;
  if (po.error) return <ErrorMessage error={po.error} />;
  const p = po.data;
  return (
    <div className="space-y-2 p-3">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-600">
            <th className="text-left">Item</th>
            <th className="text-right">Ordered</th>
            <th className="text-right">Received</th>
            <th className="text-right">Unit cost</th>
          </tr>
        </thead>
        <tbody>
          {p.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td className="text-right tabular-nums">{l.quantity}</td>
              <td className="text-right tabular-nums">{l.receivedQty}</td>
              <td className="text-right tabular-nums">{l.unitCost}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.grns.length > 0 && (
        <p className="text-xs text-slate-600">Received on: {p.grns.map((g) => g.grnNumber).join(', ')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Can perm="inventory.po.manage">
          {p.status === 'draft' && (
            <button className="btn-primary min-h-9" onClick={() => act.mutate('send')} disabled={act.isPending}>
              Mark as sent to supplier
            </button>
          )}
          {['draft', 'sent'].includes(p.status) && (
            <button className="btn-secondary min-h-9" onClick={() => act.mutate('cancel')} disabled={act.isPending}>
              Cancel order
            </button>
          )}
        </Can>
        {['sent', 'partially_received'].includes(p.status) && (
          <Can perm="inventory.receive">
            <Link className="btn-primary min-h-9" to={`/inventory/receive?po=${p.id}`}>
              Receive delivery
            </Link>
          </Can>
        )}
      </div>
      <ErrorMessage error={act.error} />
    </div>
  );
}

export default function PurchaseOrders() {
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['purchase-orders'], queryFn: () => api.get('/purchase-orders') });
  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Order from suppliers, then receive deliveries against the order."
        actions={
          <Can perm="inventory.po.manage">
            <button className="btn-primary" onClick={() => setCreating((v) => !v)}>
              {creating ? 'Close' : 'New order'}
            </button>
          </Can>
        }
      />
      <InventoryNav />
      {creating && (
        <NewOrder
          onDone={(po) => {
            setCreating(false);
            setOpen(po.id);
            list.refetch();
          }}
        />
      )}
      <section className="card" aria-label="Purchase orders">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <ErrorMessage error={list.error} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No purchase orders yet" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.data.map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-brand-50/40"
                  aria-expanded={open === p.id}
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                >
                  <span className="font-mono text-sm">{p.poNumber}</span>
                  <Badge tone={TONE[p.status]}>{p.status.replace('_', ' ')}</Badge>
                  <span className="text-sm">{p.supplier}</span>
                  <span className="text-xs text-slate-600">→ {p.store}</span>
                  <span className="ml-auto text-sm tabular-nums">{formatKES(p.totalAmount)}</span>
                  <span className="w-full text-xs text-slate-500 sm:w-auto">{formatDateTime(p.createdAt)}</span>
                </button>
                {open === p.id && <OrderDetail id={p.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

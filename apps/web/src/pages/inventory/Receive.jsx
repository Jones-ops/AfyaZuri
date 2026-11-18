import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatKES } from '@afyazuri/shared';
import { api, qs } from '../../api.js';
import { InventoryNav, ItemPicker, StoreSelect } from '../../components/inventory/common.jsx';
import { Alert, ErrorMessage, Field, PageHeader } from '../../components/ui.jsx';

const blank = (item, over = {}) => ({
  key: crypto.randomUUID(),
  item,
  batchNumber: '',
  expiryDate: '',
  quantity: '',
  packSizeId: item.packSizes?.[0]?.id ?? '',
  unitCost: '',
  ...over,
});

/** Goods received note: what arrived, which batch, when it expires, what it cost. */
export default function Receive() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [storeId, setStoreId] = useState(null);
  const [supplierId, setSupplierId] = useState('');
  const [poId, setPoId] = useState(params.get('po') ?? '');
  const [deliveryNote, setDeliveryNote] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [lines, setLines] = useState([]);
  const [done, setDone] = useState(null);
  const key = useRef(crypto.randomUUID());

  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api.get('/suppliers') });
  const pos = useQuery({
    queryKey: ['purchase-orders', 'open'],
    queryFn: async () => {
      const [a, b] = await Promise.all([
        api.get('/purchase-orders?status=sent'),
        api.get('/purchase-orders?status=partially_received'),
      ]);
      return [...a.data, ...b.data];
    },
  });
  const po = useQuery({
    queryKey: ['purchase-order', poId],
    queryFn: () => api.get(`/purchase-orders/${poId}`),
    enabled: !!poId,
  });
  // Choosing an order fills the store, supplier and what is still outstanding.
  useEffect(() => {
    if (!po.data) return;
    setStoreId(po.data.storeId);
    setSupplierId(po.data.supplierId);
    Promise.all(
      po.data.lines
        .filter((l) => Number(l.outstanding) > 0)
        .map(async (l) =>
          blank(await api.get(`/items/${l.itemId}`), { packSizeId: '', quantity: l.outstanding, unitCost: l.unitCost }),
        ),
    ).then(setLines);
  }, [po.data]);

  const set = (k, patch) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const m = useMutation({
    mutationFn: () =>
      api.post(
        '/grns',
        {
          storeId,
          supplierId,
          poId: poId || null,
          deliveryNote: deliveryNote || null,
          invoiceRef: invoiceRef || null,
          lines: lines.map((l) => ({
            itemId: l.item.id,
            batchNumber: l.batchNumber,
            expiryDate: l.expiryDate,
            quantity: l.quantity,
            packSizeId: l.packSizeId || null,
            unitCost: l.unitCost,
          })),
        },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: (grn) => {
      key.current = crypto.randomUUID();
      setDone(grn);
      setLines([]);
      setPoId('');
      setDeliveryNote('');
      setInvoiceRef('');
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['purchase-orders'] });
    },
  });
  const issues = m.error?.details?.issues ?? [];
  const lineError = (n, f) => issues.find((i) => i.path === `lines.${n}.${f}`)?.message;

  return (
    <>
      <PageHeader title="Receive goods" description="Record a delivery: batch numbers and expiry dates are required." />
      <InventoryNav />
      {done && (
        <div className="mb-4">
          <Alert kind="success">
            Received as <strong>{done.grnNumber}</strong> into {done.store}: {done.lines.length} line
            {done.lines.length === 1 ? '' : 's'}, {formatKES(done.totalAmount)}.{' '}
            <Link className="underline" to="/inventory">
              See stock
            </Link>
          </Alert>
        </div>
      )}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setDone(null);
          m.mutate();
        }}
      >
        <section className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Delivery">
          <Field label="Against purchase order (optional)">
            <select className="input" value={poId} onChange={(e) => setPoId(e.target.value)}>
              <option value="">No order</option>
              {(pos.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.poNumber} · {p.supplier} · {p.store}
                </option>
              ))}
            </select>
          </Field>
          <StoreSelect value={storeId} onChange={setStoreId} label="Into store" />
          <Field label="Supplier">
            <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Choose…</option>
              {(suppliers.data?.data ?? [])
                .filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Delivery note no.">
            <input className="input" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} />
          </Field>
          <Field label="Supplier invoice no.">
            <input className="input" value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} />
          </Field>
        </section>

        <section className="card p-4" aria-label="Lines">
          <h2 className="mb-2 font-semibold">What arrived</h2>
          {lines.length > 0 && (
            <ul className="mb-3 divide-y divide-slate-100">
              {lines.map((l, n) => (
                <li
                  key={l.key}
                  className="pop-in grid gap-2 py-3 md:grid-cols-[2fr_1fr_1fr_1fr_1.3fr_1fr_auto] md:items-end"
                >
                  <div>
                    <div className="font-medium">{l.item.name}</div>
                    <div className="text-xs text-slate-600">per {l.item.baseUnit}</div>
                  </div>
                  <Field label="Batch no." error={lineError(n, 'batchNumber')}>
                    <input
                      className="input uppercase"
                      value={l.batchNumber}
                      onChange={(e) => set(l.key, { batchNumber: e.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Expiry" error={lineError(n, 'expiryDate')}>
                    <input
                      className="input"
                      type="date"
                      value={l.expiryDate}
                      onChange={(e) => set(l.key, { expiryDate: e.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Quantity" error={lineError(n, 'quantity')}>
                    <input
                      className="input"
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) => set(l.key, { quantity: e.target.value })}
                      required
                    />
                  </Field>
                  <Field label="Counted in">
                    <select
                      className="input"
                      value={l.packSizeId}
                      onChange={(e) => set(l.key, { packSizeId: e.target.value })}
                    >
                      <option value="">{l.item.baseUnit}s</option>
                      {(l.item.packSizes ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.baseQty})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={l.packSizeId ? 'Cost per pack' : `Cost per ${l.item.baseUnit}`}
                    error={lineError(n, 'unitCost')}
                  >
                    <input
                      className="input"
                      inputMode="decimal"
                      value={l.unitCost}
                      onChange={(e) => set(l.key, { unitCost: e.target.value })}
                      required
                    />
                  </Field>
                  <button
                    type="button"
                    className="btn-secondary min-h-10"
                    aria-label={`Remove ${l.item.name}`}
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="max-w-md">
            <ItemPicker label="Add an item" onPick={(item) => setLines((ls) => [...ls, blank(item)])} />
          </div>
        </section>

        <ErrorMessage error={m.error} />
        <button className="btn-primary" disabled={m.isPending || !lines.length || !storeId || !supplierId}>
          {m.isPending ? 'Receiving…' : 'Receive into stock'}
        </button>
      </form>
      <p className="mt-3 text-xs text-slate-600">
        Expired stock is refused. You can only receive into stores of your own department.{' '}
        <Link className="underline" to={`/inventory/purchase-orders${qs({})}`}>
          Purchase orders
        </Link>
      </p>
    </>
  );
}

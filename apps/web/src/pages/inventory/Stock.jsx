import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatKES } from '@afyazuri/shared';
import { api, qs } from '../../api.js';
import { InventoryNav, StockStatus, StoreSelect } from '../../components/inventory/common.jsx';
import { Badge, EmptyState, ErrorMessage, PageHeader, Spinner } from '../../components/ui.jsx';

function Batches({ storeId, itemId }) {
  const q = useQuery({
    queryKey: ['batches', storeId, itemId],
    queryFn: () => api.get(`/stores/${storeId}/stock/${itemId}`),
  });
  if (q.isPending) return <Spinner rows={1} label="Loading batches…" />;
  if (q.error) return <ErrorMessage error={q.error} />;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-slate-600">
          <th className="py-1 text-left font-medium">Batch</th>
          <th className="py-1 text-left font-medium">Expiry</th>
          <th className="py-1 text-right font-medium">Quantity</th>
          <th className="py-1 text-right font-medium">Unit cost</th>
          <th className="py-1 text-left font-medium">Supplier</th>
        </tr>
      </thead>
      <tbody>
        {q.data.data.map((b) => (
          <tr key={b.batchId} className={b.expired ? 'text-red-700' : ''}>
            <td className="py-1 font-mono">{b.batchNumber}</td>
            <td className="py-1">
              {b.expiryDate} {b.expired && <Badge tone="red">expired — quarantined</Badge>}
            </td>
            <td className="py-1 text-right tabular-nums">{b.quantity}</td>
            <td className="py-1 text-right tabular-nums">{b.unitCost}</td>
            <td className="py-1">{b.supplier ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Stock on hand per store: usable vs expired, reorder status, suggested orders and value. */
export default function Stock() {
  const [storeId, setStoreId] = useState(null);
  const [filter, setFilter] = useState({ q: '', status: 'all' });
  const [open, setOpen] = useState(null);
  const stock = useQuery({
    queryKey: ['stock', storeId, filter],
    queryFn: () => api.get(`/stores/${storeId}/stock${qs(filter)}`),
    enabled: !!storeId,
  });
  const items = stock.data?.items ?? [];
  const value = items.reduce((s, i) => s + Number(i.value), 0);
  return (
    <>
      <PageHeader
        title="Stock"
        description="What is on the shelf in each store, what is running low and what is expiring."
      />
      <InventoryNav />
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
        <StoreSelect value={storeId} onChange={setStoreId} />
        <label className="block">
          <span className="label">Search</span>
          <input
            className="input"
            placeholder="Name, generic or code"
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          />
        </label>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {[
            ['all', 'All'],
            ['low', 'Low / out'],
            ['expiring', 'Expiring'],
          ].map(([v, l]) => (
            <button
              key={v}
              type="button"
              aria-pressed={filter.status === v}
              className={filter.status === v ? 'btn-primary min-h-9' : 'btn-secondary min-h-9'}
              onClick={() => setFilter({ ...filter, status: v })}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <section className="card overflow-x-auto" aria-label="Stock on hand">
        {!storeId || stock.isPending ? (
          <Spinner label="Counting the shelves…" />
        ) : stock.error ? (
          <div className="p-4">
            <ErrorMessage error={stock.error} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="Nothing here">No items match in this store.</EmptyState>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">Usable</th>
                <th className="text-right">Expired</th>
                <th>Next expiry</th>
                <th className="text-right">Reorder at</th>
                <th>Status</th>
                <th className="text-right">Suggested order</th>
                <th className="text-right">Value (KES)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <Fragment key={i.itemId}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="text-left font-medium text-brand-800 hover:underline"
                        aria-expanded={open === i.itemId}
                        onClick={() => setOpen(open === i.itemId ? null : i.itemId)}
                      >
                        {i.name}
                      </button>
                      <div className="text-xs text-slate-600">
                        <span className="font-mono">{i.code}</span> · per {i.baseUnit}
                        {i.genericName && ` · ${i.genericName}`}
                      </div>
                    </td>
                    <td className="text-right font-semibold tabular-nums">{i.usable}</td>
                    <td className="text-right tabular-nums">
                      {Number(i.expired) > 0 ? <span className="text-red-700">{i.expired}</span> : '—'}
                    </td>
                    <td className="whitespace-nowrap">{i.nextExpiry ?? '—'}</td>
                    <td className="text-right tabular-nums">{i.reorderLevel ?? '—'}</td>
                    <td>
                      <StockStatus status={i.status} />
                    </td>
                    <td className="text-right tabular-nums">{Number(i.suggestedOrder) > 0 ? i.suggestedOrder : '—'}</td>
                    <td className="text-right tabular-nums">{formatKES(i.value, { currency: false })}</td>
                  </tr>
                  {open === i.itemId && (
                    <tr>
                      <td colSpan={8} className="bg-slate-50/70">
                        <Batches storeId={storeId} itemId={i.itemId} />
                        <Link
                          className="mt-1 inline-block text-xs text-brand-800 hover:underline"
                          to={`/inventory/movements${qs({ storeId, itemId: i.itemId })}`}
                        >
                          Ledger for this item →
                        </Link>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td className="px-3 py-2" colSpan={7}>
                  Stock value at average cost
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatKES(value.toFixed(2))}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </section>
    </>
  );
}

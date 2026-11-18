import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatKES } from '@afyazuri/shared';
import { api, qs } from '../../api.js';
import { InventoryNav, useStores } from '../../components/inventory/common.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner } from '../../components/ui.jsx';

const LABEL = { expired: 'Expired', 30: 'Within 30 days', 60: '31–60 days', 90: '61–90 days' };
const TONE = { expired: 'red', 30: 'red', 60: 'amber', 90: 'amber' };

/** Expiry dashboard: expired stock (quarantined) and what expires in the next 30/60/90 days. */
export default function Expiry() {
  const [storeId, setStoreId] = useState('');
  const [band, setBand] = useState('');
  const stores = useStores();
  const q = useQuery({
    queryKey: ['expiry', storeId],
    queryFn: () => api.get(`/inventory/expiry${qs({ storeId: storeId || undefined })}`),
  });
  const rows = (q.data?.batches ?? []).filter((b) => !band || b.band === band);
  return (
    <>
      <PageHeader
        title="Expiry"
        description="Expired stock is quarantined: it is never dispensed or issued. Use the oldest stock first."
      />
      <InventoryNav />
      <div className="card mb-4 max-w-sm p-4">
        <Field label="Store">
          <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">All stores</option>
            {(stores.data?.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {q.isPending ? (
        <div className="card">
          <Spinner />
        </div>
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : (
        <>
          <section aria-label="Expiry bands" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {q.data.bands.map((b) => (
              <button
                key={b.band}
                type="button"
                aria-pressed={band === b.band}
                onClick={() => setBand(band === b.band ? '' : b.band)}
                className={`card card-link p-3 text-left ${band === b.band ? 'ring-2 ring-brand-600' : ''}`}
              >
                <div className="text-xs text-slate-600">{LABEL[b.band]}</div>
                <div className="text-lg font-semibold tabular-nums">{formatKES(b.value)}</div>
                <div className="text-xs text-slate-600">{b.batches} batches</div>
              </button>
            ))}
          </section>
          <section className="card overflow-x-auto" aria-label="Batches">
            {rows.length === 0 ? (
              <EmptyState title="Nothing expiring in the next 90 days" />
            ) : (
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Store</th>
                    <th>Batch</th>
                    <th>Expiry</th>
                    <th className="text-right">Quantity</th>
                    <th className="text-right">Value (KES)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={`${b.storeId}-${b.batchId}`}>
                      <td>{b.item}</td>
                      <td>{b.store}</td>
                      <td className="font-mono">{b.batchNumber}</td>
                      <td className="whitespace-nowrap">
                        {b.expiryDate} <Badge tone={TONE[b.band]}>{LABEL[b.band]}</Badge>
                      </td>
                      <td className="text-right tabular-nums">
                        {b.quantity} {b.baseUnit}
                      </td>
                      <td className="text-right tabular-nums">{formatKES(b.value, { currency: false })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}

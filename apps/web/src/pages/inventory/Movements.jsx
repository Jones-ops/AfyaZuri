import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { InventoryNav, useStores } from '../../components/inventory/common.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner, formatDateTime } from '../../components/ui.jsx';

const TYPE = {
  grn: 'Received',
  issue_out: 'Issued out',
  issue_in: 'Issued in',
  dispense: 'Dispensed',
  dispense_return: 'Returned',
  otc_sale: 'Sold (OTC)',
  adjustment: 'Adjustment',
  stocktake: 'Stock take',
  expiry_writeoff: 'Expiry write-off',
};

/** The stock ledger: every movement, newest first. Rows can never be edited or deleted. */
export default function Movements() {
  const [params, setParams] = useSearchParams();
  const storeId = params.get('storeId') ?? '';
  const itemId = params.get('itemId') ?? '';
  const stores = useStores();
  const q = useInfiniteQuery({
    queryKey: ['movements', storeId, itemId],
    queryFn: ({ pageParam }) =>
      api.get(
        `/stock-movements${qs({ storeId: storeId || undefined, itemId: itemId || undefined, before: pageParam, limit: 100 })}`,
      ),
    initialPageParam: undefined,
    getNextPageParam: (last) => (last.data.length === 100 ? last.data.at(-1).id : undefined),
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <PageHeader
        title="Stock ledger"
        description="Every receipt, issue, dispense and adjustment. Entries are permanent."
      />
      <InventoryNav />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="Store">
          <select
            className="input"
            value={storeId}
            onChange={(e) => setParams(e.target.value ? { storeId: e.target.value, ...(itemId && { itemId }) } : {})}
          >
            <option value="">All stores</option>
            {(stores.data?.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {itemId && (
          <button className="btn-secondary" onClick={() => setParams(storeId ? { storeId } : {})}>
            Show all items
          </button>
        )}
      </div>
      <section className="card overflow-x-auto" aria-label="Movements">
        {q.isPending ? (
          <Spinner />
        ) : q.error ? (
          <ErrorMessage error={q.error} />
        ) : rows.length === 0 ? (
          <EmptyState title="No movements yet" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>When</th>
                <th>Item</th>
                <th>Store</th>
                <th>Batch</th>
                <th>Movement</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Balance</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap">{formatDateTime(m.at)}</td>
                  <td>{m.item}</td>
                  <td>{m.store}</td>
                  <td className="font-mono text-xs">
                    {m.batchNumber}
                    <div className="text-slate-500">exp {m.expiryDate}</div>
                  </td>
                  <td>
                    <Badge tone={Number(m.quantity) > 0 ? 'green' : 'slate'}>{TYPE[m.type] ?? m.type}</Badge>
                    {m.reason && <div className="text-xs text-slate-600">{m.reason}</div>}
                  </td>
                  <td
                    className={`text-right tabular-nums ${Number(m.quantity) < 0 ? 'text-red-700' : 'text-emerald-800'}`}
                  >
                    {Number(m.quantity) > 0 ? `+${m.quantity}` : m.quantity}
                  </td>
                  <td className="text-right tabular-nums">{m.balanceAfter}</td>
                  <td className="text-xs">{m.by ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {q.hasNextPage && (
        <button className="btn-secondary mt-3" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          Load more
        </button>
      )}
    </>
  );
}

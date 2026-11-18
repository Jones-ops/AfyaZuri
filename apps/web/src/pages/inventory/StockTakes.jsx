import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatKES } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Can, useAuth } from '../../auth.jsx';
import { InventoryNav, StoreSelect } from '../../components/inventory/common.jsx';
import { Badge, EmptyState, ErrorMessage, PageHeader, Spinner, formatDateTime } from '../../components/ui.jsx';

const TONE = { counting: 'amber', submitted: 'blue', approved: 'green', rejected: 'red', cancelled: 'slate' };

/** Count sheet. While counting, the system quantity is hidden (a blind count). */
function Sheet({ id }) {
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const t = useQuery({ queryKey: ['stock-take', id], queryFn: () => api.get(`/stock-takes/${id}`) });
  const [edits, setEdits] = useState({});
  const refresh = () => {
    setEdits({});
    qc.invalidateQueries({ queryKey: ['stock-take', id] });
    qc.invalidateQueries({ queryKey: ['stock-takes'] });
    qc.invalidateQueries({ queryKey: ['stock'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.put(`/stock-takes/${id}/counts`, {
        lines: Object.entries(edits)
          .filter(([, v]) => v.countedQty !== '')
          .map(([lineId, v]) => ({ lineId, countedQty: v.countedQty, reason: v.reason || null })),
      }),
    onSuccess: refresh,
  });
  const act = useMutation({
    mutationFn: ({ path, body }) => api.post(`/stock-takes/${id}/${path}`, body),
    onSuccess: refresh,
  });
  if (t.isPending) return <Spinner rows={4} label="Loading the count sheet…" />;
  if (t.error) return <ErrorMessage error={t.error} />;
  const d = t.data;
  const counting = d.status === 'counting';
  const tookPart = d.startedById === me.user.id || d.lines.some((l) => l.countedById === me.user.id);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={TONE[d.status]}>{d.status}</Badge>
        <span>
          {d.counted} of {d.lines.length} lines counted
        </span>
        {!counting && (
          <span>
            Gains {formatKES(d.gainValue)} · Losses <span className="text-red-700">{formatKES(d.lossValue)}</span>
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Item</th>
              <th>Batch</th>
              <th>Expiry</th>
              {!counting && <th className="text-right">System</th>}
              <th className="text-right">Counted</th>
              {!counting && <th className="text-right">Variance</th>}
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => {
              const e = edits[l.id] ?? { countedQty: l.countedQty ?? '', reason: l.reason ?? '' };
              const set = (patch) => setEdits({ ...edits, [l.id]: { ...e, ...patch } });
              return (
                <tr key={l.id} className={l.expired ? 'text-red-700' : ''}>
                  <td>
                    {l.name} <span className="text-xs text-slate-600">({l.baseUnit})</span>
                  </td>
                  <td className="font-mono text-xs">{l.batchNumber}</td>
                  <td className="whitespace-nowrap">{l.expiryDate}</td>
                  {!counting && <td className="text-right tabular-nums">{l.systemQty}</td>}
                  <td className="text-right">
                    {counting ? (
                      <input
                        aria-label={`Count of ${l.name} batch ${l.batchNumber}`}
                        className="input ml-auto min-h-8 w-24 text-right"
                        inputMode="decimal"
                        value={e.countedQty}
                        onChange={(ev) => set({ countedQty: ev.target.value })}
                      />
                    ) : (
                      <span className="tabular-nums">{l.countedQty}</span>
                    )}
                  </td>
                  {!counting && (
                    <td
                      className={`text-right tabular-nums ${Number(l.variance) < 0 ? 'text-red-700' : Number(l.variance) > 0 ? 'text-emerald-800' : ''}`}
                    >
                      {l.variance}
                    </td>
                  )}
                  <td>
                    {counting ? (
                      <input
                        aria-label={`Reason for ${l.name} batch ${l.batchNumber}`}
                        className="input min-h-8"
                        placeholder="If it differs"
                        value={e.reason}
                        onChange={(ev) => set({ reason: ev.target.value })}
                      />
                    ) : (
                      <span className="text-xs">{l.reason}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        {counting && (
          <Can perm="inventory.stocktake.perform">
            <button
              className="btn-secondary"
              disabled={save.isPending || !Object.keys(edits).length}
              onClick={() => save.mutate()}
            >
              Save counts
            </button>
            <button
              className="btn-primary"
              disabled={act.isPending || Object.keys(edits).length > 0}
              onClick={() => act.mutate({ path: 'submit' })}
            >
              Submit for approval
            </button>
          </Can>
        )}
        {d.status === 'submitted' &&
          can('inventory.stocktake.approve') &&
          (tookPart ? (
            <p className="text-sm text-slate-600">Someone who did not count must approve.</p>
          ) : (
            <>
              <button
                className="btn-primary"
                disabled={act.isPending}
                onClick={() => act.mutate({ path: 'decision', body: { approve: true } })}
              >
                Approve and post variances
              </button>
              <button
                className="btn-secondary"
                disabled={act.isPending}
                onClick={() => act.mutate({ path: 'decision', body: { approve: false } })}
              >
                Reject (recount)
              </button>
            </>
          ))}
        {['counting', 'submitted'].includes(d.status) && (
          <Can perm="inventory.stocktake.perform">
            <button className="btn-secondary" disabled={act.isPending} onClick={() => act.mutate({ path: 'cancel' })}>
              Abandon count
            </button>
          </Can>
        )}
      </div>
      <ErrorMessage error={save.error ?? act.error} />
    </div>
  );
}

/** Stock takes: blind count, explain variances, someone else approves. */
export default function StockTakes() {
  const qc = useQueryClient();
  const [storeId, setStoreId] = useState(null);
  const [open, setOpen] = useState(null);
  const list = useQuery({ queryKey: ['stock-takes'], queryFn: () => api.get('/stock-takes') });
  const start = useMutation({
    mutationFn: () => api.post('/stock-takes', { storeId }),
    onSuccess: (t) => {
      setOpen(t.id);
      qc.invalidateQueries({ queryKey: ['stock-takes'] });
    },
  });
  return (
    <>
      <PageHeader
        title="Stock takes"
        description="Count what is on the shelf. Variances post to the ledger only after someone else approves."
      />
      <InventoryNav />
      <Can perm="inventory.stocktake.perform">
        <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-56">
            <StoreSelect value={storeId} onChange={setStoreId} />
          </div>
          <button className="btn-primary" disabled={!storeId || start.isPending} onClick={() => start.mutate()}>
            Start a count
          </button>
          <div className="basis-full">
            <ErrorMessage error={start.error} />
          </div>
        </div>
      </Can>
      <section className="card" aria-label="Stock takes">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <ErrorMessage error={list.error} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No stock takes yet" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.data.map((t) => (
              <li key={t.id}>
                <button
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-brand-50/40"
                  aria-expanded={open === t.id}
                  onClick={() => setOpen(open === t.id ? null : t.id)}
                >
                  <span className="font-mono text-sm">{t.stNumber}</span>
                  <Badge tone={TONE[t.status]}>{t.status}</Badge>
                  <span className="text-sm">{t.store}</span>
                  <span className="ml-auto text-xs text-slate-600">
                    {t.startedBy}, {formatDateTime(t.startedAt)}
                  </span>
                </button>
                {open === t.id && (
                  <div className="border-t border-slate-100 bg-slate-50/50 p-4">
                    <Sheet id={t.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

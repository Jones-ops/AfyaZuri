import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AUDIT_ACTIONS } from '@afyazuri/shared';
import { api, qs } from '../api.js';
import { Can } from '../auth.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner, formatDateTime } from '../components/ui.jsx';

export default function Audit() {
  const [f, setF] = useState({ action: '', entityType: '', from: '', to: '' });
  const [open, setOpen] = useState(null);
  const filters = { action: f.action, entityType: f.entityType, from: f.from && new Date(f.from).toISOString(), to: f.to && new Date(`${f.to}T23:59:59`).toISOString() };
  const list = useInfiniteQuery({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam }) => api.get(`/audit${qs({ ...filters, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of every change, sign-in and record access."
        actions={<Can perm="audit.export"><a className="btn-secondary" href={`/api/v1/audit/export${qs(filters)}`}>Export CSV</a></Can>} />
      <div className="card mb-3 grid gap-3 p-3 sm:grid-cols-4">
        <Field label="Action"><select className="input" value={f.action} onChange={set('action')}><option value="">Any</option>{AUDIT_ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></Field>
        <Field label="Entity type"><input className="input" placeholder="e.g. user" value={f.entityType} onChange={set('entityType')} /></Field>
        <Field label="From"><input className="input" type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="To"><input className="input" type="date" value={f.to} onChange={set('to')} /></Field>
      </div>
      <div className="card overflow-x-auto">
        {list.isPending ? <Spinner /> : list.error ? <div className="p-4"><ErrorMessage error={list.error} /></div> : rows.length === 0 ? <EmptyState title="No matching entries" /> : (
          <table className="table-base">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{formatDateTime(r.occurredAt)}</td>
                  <td>{r.actorUsername ?? '—'}<div className="text-xs text-slate-600">{r.ip}</div></td>
                  <td><Badge tone={r.action.includes('fail') || r.action === 'token_reuse' || r.action === 'lockout' ? 'red' : 'slate'}>{r.action}</Badge></td>
                  <td>{r.entityType}<div className="font-mono text-xs text-slate-600">{r.entityId?.slice(0, 8)}</div></td>
                  <td>
                    {(r.changes || r.metadata || r.reason) && (
                      <button className="text-sm text-brand-800 hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Show'}</button>
                    )}
                    {open === r.id && <pre className="mt-1 max-w-md overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify({ reason: r.reason ?? undefined, changes: r.changes ?? undefined, metadata: r.metadata ?? undefined }, null, 2)}</pre>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {list.hasNextPage && <button className="btn-secondary mt-3" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Load more</button>}
    </>
  );
}

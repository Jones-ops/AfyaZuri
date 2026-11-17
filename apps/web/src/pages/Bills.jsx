import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatKES } from '@afyazuri/shared';
import { api, qs } from '../api.js';
import { Badge, EmptyState, ErrorMessage, PageHeader, Spinner, formatDateTime } from '../components/ui.jsx';

export const BILL_STATUS_TONE = { open: 'blue', final: 'amber', closed: 'green', cancelled: 'slate' };

export default function Bills() {
  const [status, setStatus] = useState('outstanding');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useInfiniteQuery({
    queryKey: ['bills', status, term],
    queryFn: ({ pageParam }) => api.get(`/bills${qs({ status, q: term, cursor: pageParam })}`),
    initialPageParam: undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Bills"
        description="Every visit has one bill. Charges post automatically from check-in and clinical departments."
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          className="input max-w-xs"
          aria-label="Search bills"
          placeholder="Bill number, MRN or name"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="input w-auto" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="outstanding">Outstanding (patient owes)</option>
          <option value="open">Open visits</option>
          <option value="final">Final</option>
          <option value="closed">Settled</option>
          <option value="all">All</option>
        </select>
      </div>
      <div className="card overflow-x-auto">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <ErrorMessage error={list.error} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No bills" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Patient</th>
                <th>Payer</th>
                <th className="text-right">Total</th>
                <th className="text-right">Patient owes</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td className="whitespace-nowrap">
                    <Link
                      to={`/billing/bills/${b.id}`}
                      className="font-mono font-medium text-brand-800 hover:underline"
                    >
                      {b.billNumber}
                    </Link>
                    <div className="text-xs text-slate-600">{formatDateTime(b.openedAt)}</div>
                  </td>
                  <td>
                    {b.patient.fullName}
                    <div className="font-mono text-xs text-slate-600">{b.patient.mrn}</div>
                  </td>
                  <td>{b.payer ? b.payer.schemeName : 'Cash'}</td>
                  <td className="text-right whitespace-nowrap">{formatKES(b.totalAmount)}</td>
                  <td className="text-right font-semibold whitespace-nowrap">{formatKES(b.balance)}</td>
                  <td>
                    <Badge tone={BILL_STATUS_TONE[b.status]}>{b.status === 'closed' ? 'settled' : b.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {list.hasNextPage && (
        <button className="btn-secondary mt-3" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          More
        </button>
      )}
    </>
  );
}

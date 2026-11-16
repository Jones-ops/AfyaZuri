import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, EmptyState, ErrorMessage, PageHeader, Spinner, formatDateTime } from '../components/ui.jsx';

/** Review queue for emergency ("break-the-glass") access to restricted records. */
export default function BreakGlassReview() {
  const [status, setStatus] = useState('unreviewed');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['break-glass', status], queryFn: () => api.get(`/break-glass?status=${status}`) });
  const review = useMutation({
    mutationFn: ({ id, outcome }) => api.post(`/break-glass/${id}/review`, { outcome }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['break-glass'] }),
  });

  return (
    <>
      <PageHeader
        title="Emergency access review"
        description="Every use of break-the-glass on a restricted record, with the reason given. Confirm each was justified."
        actions={
          <select className="input w-auto" aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="unreviewed">Awaiting review</option>
            <option value="all">All</option>
          </select>
        }
      />
      <ErrorMessage error={review.error} />
      <div className="card overflow-x-auto">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <div className="p-4">
            <ErrorMessage error={list.error} />
          </div>
        ) : list.data.data.length === 0 ? (
          <EmptyState title="Nothing to review" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>When</th>
                <th>Staff</th>
                <th>Patient</th>
                <th>Reason</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((g) => (
                <tr key={g.id}>
                  <td className="whitespace-nowrap">{formatDateTime(g.grantedAt)}</td>
                  <td>{g.userName}</td>
                  <td>
                    <Link className="font-mono text-brand-800 hover:underline" to={`/patients/${g.patientId}`}>
                      {g.mrn}
                    </Link>
                  </td>
                  <td className="max-w-md">{g.reason}</td>
                  <td className="whitespace-nowrap">
                    {g.reviewedAt ? (
                      <Badge tone={g.outcome === 'justified' ? 'green' : 'red'}>
                        {g.outcome} · {g.reviewedBy}
                      </Badge>
                    ) : (
                      <span className="flex gap-1">
                        <button
                          className="btn-secondary min-h-8 px-2 text-xs"
                          onClick={() => review.mutate({ id: g.id, outcome: 'justified' })}
                        >
                          Justified
                        </button>
                        <button
                          className="btn-danger min-h-8 px-2 text-xs"
                          onClick={() => review.mutate({ id: g.id, outcome: 'unjustified' })}
                        >
                          Not justified
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

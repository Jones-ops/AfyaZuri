import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, EmptyState, ErrorMessage, PageHeader, Spinner } from '../components/ui.jsx';

/** All service-point queues with live counts. */
export default function Queues() {
  const q = useQuery({ queryKey: ['queues'], queryFn: () => api.get('/queues'), refetchInterval: 15_000 });
  return (
    <>
      <PageHeader title="Queues" description="Live waiting lists for every service point. Refreshes automatically." />
      {q.isPending ? (
        <Spinner />
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : q.data.data.length === 0 ? (
        <div className="card">
          <EmptyState title="No queues set up">Add service points under Facility setup.</EmptyState>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {q.data.data.map((x) => (
            <Link key={x.id} to={`/opd/queues/${x.id}`} className="card block p-4 hover:border-brand-600">
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">{x.name}</h2>
                {!x.canManage && <Badge>view only</Badge>}
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div>
                  <dt className="text-xs text-slate-600">Waiting</dt>
                  <dd className="text-2xl font-semibold">{x.waiting}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-600">Serving</dt>
                  <dd className="text-2xl font-semibold">{x.serving}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-600">Done today</dt>
                  <dd className="text-2xl font-semibold">{x.servedToday}</dd>
                </div>
              </dl>
              {x.longestWaitMinutes !== null && (
                <p className={`mt-2 text-sm ${x.longestWaitMinutes >= 60 ? 'text-red-700' : 'text-slate-600'}`}>
                  Longest wait {x.longestWaitMinutes} min
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

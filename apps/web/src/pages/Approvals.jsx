import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { AdjustmentRow } from '../components/billing/Adjustments.jsx';
import { EmptyState, ErrorMessage, PageHeader, Spinner } from '../components/ui.jsx';

/** Waivers, credit notes and refunds waiting for this user, and approved refunds to pay out. */
export default function Approvals() {
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api.get('/approvals'), refetchInterval: 30_000 });
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Requests raised by colleagues. You never see your own: someone else must approve them."
      />
      {q.isPending ? (
        <div className="card">
          <Spinner />
        </div>
      ) : q.error ? (
        <ErrorMessage error={q.error} />
      ) : (
        <>
          <section className="card mb-4 p-4" aria-labelledby="decide-h">
            <h2 id="decide-h" className="font-semibold">
              Waiting for your decision ({q.data.toDecide.length})
            </h2>
            {q.data.toDecide.length ? (
              <ul className="divide-y divide-slate-100">
                {q.data.toDecide.map((i) => (
                  <AdjustmentRow key={`${i.kind}-${i.id}`} item={i} showBill />
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing to approve" />
            )}
          </section>
          {q.data.toPay.length > 0 && (
            <section className="card mb-4 p-4" aria-labelledby="pay-h">
              <h2 id="pay-h" className="font-semibold">
                Approved refunds to pay out ({q.data.toPay.length})
              </h2>
              <ul className="divide-y divide-slate-100">
                {q.data.toPay.map((i) => (
                  <AdjustmentRow key={i.id} item={i} showBill />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}

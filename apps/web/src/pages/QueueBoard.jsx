import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatKES } from '@afyazuri/shared';
import { api } from '../api.js';
import { Can } from '../auth.jsx';
import { Alert, Badge, EmptyState, ErrorMessage, PageHeader, PageSkeleton } from '../components/ui.jsx';

const PRIORITY = { 2: ['Emergency', 'red'], 1: ['Urgent', 'amber'] };
const STEP_LABEL = {
  return: 'Back to referring room',
  exit: 'Exit (end visit)',
  cashier: 'Cashier',
  triage: 'Triage',
  consultation: 'Consultation',
  laboratory: 'Laboratory',
  imaging: 'Radiology',
  pharmacy: 'Pharmacy',
  procedure: 'Procedure room',
};

export default function QueueBoard() {
  const { id } = useParams();
  const qc = useQueryClient();
  const board = useQuery({
    queryKey: ['board', id],
    queryFn: () => api.get(`/queues/${id}/board`),
    refetchInterval: 10_000,
  });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api.get('/queues'), staleTime: 60_000 });
  const [done, setDone] = useState(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['board', id] });
    qc.invalidateQueries({ queryKey: ['queues'] });
  };
  const callNext = useMutation({ mutationFn: () => api.post(`/queues/${id}/call-next`), onSuccess: refresh });
  const act = useMutation({
    mutationFn: ({ t, action }) => api.post(`/queue-tickets/${t.id}/${action}`),
    onSuccess: refresh,
  });
  const complete = useMutation({
    mutationFn: ({ t, next }) => api.post(`/queue-tickets/${t.id}/complete`, { next }),
    onSuccess: (r) => {
      setDone(r);
      refresh();
    },
  });

  if (board.isPending) return <PageSkeleton />;
  if (board.error) return <ErrorMessage error={board.error} />;
  const b = board.data;
  const destinations = (queues.data?.data ?? []).filter(
    (q) => q.id !== id && !['registration', 'exit'].includes(q.type),
  );
  const err = callNext.error || act.error || complete.error;
  const ticketProps = { canManage: b.canManage, destinations, act, complete };

  return (
    <>
      <PageHeader
        title={b.queue.name}
        description={
          b.canManage
            ? 'Call patients in order: emergencies first, then the longest waiting.'
            : 'View only — this queue belongs to another department.'
        }
        actions={
          <>
            <Link to={`/opd/display/${id}`} className="btn-secondary" target="_blank" rel="noopener">
              TV display
            </Link>
            {b.canManage && (
              <button
                className="btn-primary"
                onClick={() => callNext.mutate()}
                disabled={callNext.isPending || b.waiting.length === 0}
              >
                Call next
              </button>
            )}
          </>
        }
      />
      {done && (
        <div className="mb-3">
          <Alert kind="success">
            {done.encounterClosed
              ? 'Visit ended.'
              : `Sent on: ticket ${done.nextTicket.label} at ${done.nextTicket.servicePointName ?? done.nextTicket.queueName}.`}
          </Alert>
        </div>
      )}
      {err && (
        <div className="mb-3">
          <ErrorMessage error={err} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Column title="Waiting" items={b.waiting} empty="Nobody waiting" ticketProps={ticketProps} />
        <Column title="Called" items={b.called} empty="Nobody called" ticketProps={ticketProps} />
        <Column title="In service" items={b.inService} empty="Nobody in service" ticketProps={ticketProps} />
      </div>
    </>
  );
}

function Column({ title, items, empty, ticketProps }) {
  return (
    <section className="min-w-0" aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold text-slate-700">
        {title} ({items.length})
      </h2>
      {items.length ? (
        <ul className="space-y-2">
          {items.map((t) => (
            <Ticket key={t.id} t={t} {...ticketProps} />
          ))}
        </ul>
      ) : (
        <div className="card">
          <EmptyState title={empty} />
        </div>
      )}
    </section>
  );
}

function Ticket({ t, canManage, destinations, act, complete }) {
  const small = 'min-h-9 px-3 text-xs';
  return (
    <li className="rounded-md border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-lg font-bold">{t.label}</span>
        <span className="flex flex-wrap gap-1">
          {PRIORITY[t.priority] && <Badge tone={PRIORITY[t.priority][1]}>{PRIORITY[t.priority][0]}</Badge>}
          {t.payerType && t.payerType !== 'cash' && <Badge tone="blue">{t.payerType.toUpperCase()}</Badge>}
          {t.unpaid && <Badge tone="red">Unpaid {formatKES(t.balance)}</Badge>}
          <Badge>{t.waitMinutes} min</Badge>
        </span>
      </div>
      <Link to={`/patients/${t.patient.id}`} className="mt-1 block font-medium text-brand-800 hover:underline">
        {t.patient.fullName}
      </Link>
      <p className="text-xs text-slate-600">
        {t.patient.age} · {t.patient.sex} · <span className="font-mono">{t.patient.mrn}</span>
      </p>
      <Can perm="emr.read">
        <Link to={`/encounters/${t.encounterId}`} className="text-xs text-brand-800 hover:underline">
          Open visit
        </Link>
      </Can>
      {t.billId && t.unpaid && (
        <Can perm="billing.payment.receive">
          <Link to={`/billing/bills/${t.billId}`} className="ml-3 text-xs font-semibold text-brand-800 hover:underline">
            Take payment
          </Link>
        </Can>
      )}
      {canManage && (
        <div className="mt-2 flex flex-wrap gap-1">
          {t.status === 'waiting' && (
            <button className={`btn-secondary ${small}`} onClick={() => act.mutate({ t, action: 'call' })}>
              Call
            </button>
          )}
          {t.status !== 'in_service' && (
            <button className={`btn-primary ${small}`} onClick={() => act.mutate({ t, action: 'start' })}>
              Start
            </button>
          )}
          {t.status !== 'waiting' && (
            <>
              <button
                className={`btn-primary ${small}`}
                onClick={() =>
                  complete.mutate({ t, next: t.nextStep === 'exit' ? { kind: 'exit' } : { kind: 'route' } })
                }
              >
                Send to: {STEP_LABEL[t.nextStep] ?? t.nextStep}
              </button>
              <select
                aria-label={`Send ${t.label} elsewhere`}
                className="input min-h-9 w-auto text-xs"
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'exit') complete.mutate({ t, next: { kind: 'exit' } });
                  else if (v) complete.mutate({ t, next: { kind: 'service_point', servicePointId: v } });
                }}
              >
                <option value="">Send elsewhere…</option>
                {destinations.map((q) => (
                  <option key={q.id} value={q.servicePointId}>
                    {q.name}
                  </option>
                ))}
                <option value="exit">Exit (end visit)</option>
              </select>
            </>
          )}
          {t.status !== 'in_service' && (
            <button className={`btn-secondary ${small}`} onClick={() => act.mutate({ t, action: 'no-show' })}>
              No-show
            </button>
          )}
          {t.status !== 'waiting' && (
            <button className={`btn-secondary ${small}`} onClick={() => act.mutate({ t, action: 'requeue' })}>
              Back to waiting
            </button>
          )}
        </div>
      )}
    </li>
  );
}

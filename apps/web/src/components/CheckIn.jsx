import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Can } from '../auth.jsx';
import { Badge, ErrorMessage, Field } from './ui.jsx';

/**
 * Current visit for a patient, or a check-in form when there is none.
 * @param {{patient: any}} props
 */
export default function CheckIn({ patient: p }) {
  const qc = useQueryClient();
  const visit = useQuery({
    queryKey: ['visit', p.id],
    queryFn: () => api.get(`/encounters?patientId=${p.id}&status=open&limit=1`),
    refetchInterval: 15_000,
  });
  const current = visit.data?.data[0];
  const [type, setType] = useState('opd');
  const [scheme, setScheme] = useState(p.payerSchemes.find((s) => s.isPrimary)?.id ?? '');
  const [priority, setPriority] = useState(0);
  const clientId = useRef(crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api.post('/encounters', {
        patientId: p.id,
        type,
        priority: Number(priority),
        patientPayerSchemeId: scheme || null,
        clientId: clientId.current,
      }),
    onSuccess: () => {
      clientId.current = crypto.randomUUID();
      qc.invalidateQueries({ queryKey: ['visit', p.id] });
      qc.invalidateQueries({ queryKey: ['queues'] });
    },
  });

  if (visit.isPending) return null;
  return (
    <section className="card mb-4 p-4" aria-label="Visit">
      {current ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">
              Current visit <Badge tone={current.type === 'emergency' ? 'red' : 'teal'}>{current.type}</Badge>
            </h2>
            <p className="text-sm text-slate-700">
              {current.currentTicket ? (
                <>
                  Ticket <strong className="font-mono text-base">{current.currentTicket.label}</strong> ·{' '}
                  {current.currentTicket.status === 'waiting'
                    ? `please go to ${current.currentTicket.servicePointName}`
                    : `${current.currentTicket.servicePointName} (${current.currentTicket.status.replace('_', ' ')})`}
                </>
              ) : (
                'Not in a queue'
              )}{' '}
              · {current.schemeName ?? 'Cash'} ·{' '}
              {current.billingMode === 'pay_first' ? 'pay before service' : 'bill at exit'}
            </p>
          </div>
          <span className="flex flex-wrap gap-2">
            <Can perm="emr.read">
              <Link className="btn-primary" to={`/encounters/${current.id}`}>
                Open visit
              </Link>
            </Can>
            {current.currentTicket && (
              <Can perm="opd.queue.read">
                <Link className="btn-secondary" to={`/opd/queues/${current.currentTicket.queueId}`}>
                  Open {current.currentTicket.queueName} queue
                </Link>
              </Can>
            )}
          </span>
        </div>
      ) : (
        <Can perm="opd.checkin" fallback={<p className="text-sm text-slate-600">No open visit.</p>}>
          <form
            className="grid gap-3 sm:grid-cols-[auto,1fr,auto,auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
          >
            <Field label="Visit">
              <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                <option value="opd">Outpatient</option>
                <option value="emergency">Emergency</option>
              </select>
            </Field>
            <Field label="Bill to">
              <select className="input" value={scheme} onChange={(e) => setScheme(e.target.value)}>
                <option value="">Cash / self-pay</option>
                {p.payerSchemes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.payerName} — {s.schemeName} ({s.memberNumber})
                  </option>
                ))}
              </select>
            </Field>
            {type === 'opd' && (
              <Field label="Priority">
                <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value={0}>Routine</option>
                  <option value={1}>Urgent</option>
                </select>
              </Field>
            )}
            <button className="btn-primary" disabled={m.isPending}>
              Check in
            </button>
          </form>
          <ErrorMessage error={m.error} />
        </Can>
      )}
    </section>
  );
}

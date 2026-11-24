import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { LAB_PRIORITIES } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Can } from '../../auth.jsx';
import { Badge, ErrorMessage, Field, formatDateTime } from '../ui.jsx';

export const IMAGING_TONE = {
  ordered: 'slate',
  scheduled: 'blue',
  performed: 'blue',
  reported: 'amber',
  released: 'green',
  cancelled: 'slate',
};

/** Released report text, attachments and amendment history. */
export function ImagingReport({ o }) {
  if (!o.report) return null;
  return (
    <div className="mt-2 rounded border border-slate-200 bg-white/60 p-2 text-sm">
      <p className="whitespace-pre-line">{o.report.findings}</p>
      <p className="mt-1">
        <strong>Impression:</strong> {o.report.impression}
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Reported by {o.report.reportedBy}, {formatDateTime(o.report.reportedAt)}
        {o.accessionNumber && ` · Accession ${o.accessionNumber}`}
      </p>
      {o.amendments.length > 0 && (
        <p className="text-xs text-amber-800">
          Amended: {o.amendments.map((a) => `v${a.version} — ${a.reason} (${a.by})`).join('; ')}
        </p>
      )}
      {o.attachments.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-2 text-xs">
          {o.attachments.map((a) => (
            <li key={a.id}>
              <a
                className="text-brand-800 underline"
                href={`/api/v1/imaging-orders/${o.id}/attachments/${a.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {a.fileName}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderForm({ encounterId, onDone }) {
  const studies = useQuery({
    queryKey: ['imaging', 'studies'],
    queryFn: () => api.get('/imaging/studies'),
    staleTime: 300_000,
  });
  const [studyId, setStudyId] = useState('');
  const [priority, setPriority] = useState('routine');
  const [indication, setIndication] = useState('');
  const key = useRef(crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api.post(
        `/encounters/${encounterId}/imaging-orders`,
        { studyId, priority, clinicalIndication: indication, clientId: key.current },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: () => {
      key.current = crypto.randomUUID();
      setStudyId('');
      setIndication('');
      onDone();
    },
  });
  const chosen = studies.data?.data.find((s) => s.id === studyId);
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
        <Field label="Study">
          <select className="input" value={studyId} onChange={(e) => setStudyId(e.target.value)}>
            <option value="">Choose…</option>
            {(studies.data?.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.modality})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {LAB_PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
      </div>
      {chosen?.preparation && <p className="text-xs text-amber-800">Preparation: {chosen.preparation}</p>}
      <Field label="Clinical indication (required)" hint="Why is this study needed? The radiologist reads this.">
        <textarea className="input min-h-16 py-2" value={indication} onChange={(e) => setIndication(e.target.value)} />
      </Field>
      <ErrorMessage error={m.error} />
      <button
        className="btn-primary"
        disabled={!studyId || indication.trim().length < 5 || m.isPending}
        onClick={() => m.mutate()}
      >
        Request study
      </button>
    </div>
  );
}

/** Imaging requested in this visit, with released reports. */
export default function ImagingPanel({ encounterId }) {
  const qc = useQueryClient();
  const [ordering, setOrdering] = useState(false);
  const list = useQuery({
    queryKey: ['imaging-orders', encounterId],
    queryFn: () => api.get(`/encounters/${encounterId}/imaging-orders`),
  });
  return (
    <section className="card p-4" aria-labelledby="img-h">
      <div className="flex items-center justify-between">
        <h2 id="img-h" className="font-semibold">
          Imaging
        </h2>
        <Can perm="orders.imaging.create">
          <button className="btn-secondary min-h-9" onClick={() => setOrdering((v) => !v)}>
            {ordering ? 'Close' : 'Request imaging'}
          </button>
        </Can>
      </div>
      <ErrorMessage error={list.error} />
      {(list.data?.data ?? []).map((o) => (
        <div key={o.id} className="mt-3 rounded-md border border-slate-200 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{o.study.name}</span>
            <Badge tone={IMAGING_TONE[o.status]}>{o.status}</Badge>
            {o.priority !== 'routine' && <Badge tone="red">{o.priority}</Badge>}
            {o.overdue && <Badge tone="red">overdue</Badge>}
            <span className="text-xs text-slate-600">
              {o.orderNumber} · {o.orderedBy}, {formatDateTime(o.orderedAt)}
            </span>
          </div>
          <p className="text-xs text-slate-700">Indication: {o.clinicalIndication}</p>
          <ImagingReport o={o} />
        </div>
      ))}
      {list.data && list.data.data.length === 0 && !ordering && (
        <p className="mt-2 text-sm text-slate-600">No imaging in this visit.</p>
      )}
      {ordering && (
        <OrderForm
          encounterId={encounterId}
          onDone={() => {
            setOrdering(false);
            qc.invalidateQueries({ queryKey: ['imaging-orders', encounterId] });
          }}
        />
      )}
    </section>
  );
}

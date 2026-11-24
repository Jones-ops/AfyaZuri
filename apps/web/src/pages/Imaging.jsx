import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MODALITIES } from '@afyazuri/shared';
import { api, qs } from '../api.js';
import { Can } from '../auth.jsx';
import { IMAGING_TONE, ImagingReport } from '../components/emr/ImagingPanel.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner, formatDateTime } from '../components/ui.jsx';

const STAGES = [
  ['schedule', 'To schedule'],
  ['perform', 'To perform'],
  ['report', 'To report'],
  ['done', 'Released (24 h)'],
];

function ReportEditor({ o, amend, onDone }) {
  const templates = useQuery({
    queryKey: ['imaging', 'templates', o.study.modality],
    queryFn: () => api.get(`/imaging/templates${qs({ modality: o.study.modality })}`),
  });
  const [findings, setFindings] = useState(o.report?.findings ?? '');
  const [impression, setImpression] = useState(o.report?.impression ?? '');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post(`/imaging-orders/${o.id}/${amend ? 'amend' : 'report'}`, {
        findings,
        impression,
        ...(amend ? { reason } : {}),
      }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white/70 p-3">
      <Field label="Start from a template">
        <select
          className="input"
          defaultValue=""
          onChange={(e) => {
            const t = templates.data?.data.find((x) => x.id === e.target.value);
            if (t) {
              setFindings(t.findings);
              setImpression(t.impression ?? '');
            }
          }}
        >
          <option value="">Choose…</option>
          {(templates.data?.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Findings">
        <textarea className="input min-h-32 py-2" value={findings} onChange={(e) => setFindings(e.target.value)} />
      </Field>
      <Field label="Impression">
        <textarea className="input min-h-16 py-2" value={impression} onChange={(e) => setImpression(e.target.value)} />
      </Field>
      {amend && (
        <Field label="Reason for amendment">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      <ErrorMessage error={m.error} />
      <button
        className="btn-primary min-h-9"
        disabled={m.isPending || (amend && reason.trim().length < 5)}
        onClick={() => m.mutate()}
      >
        {amend ? 'Release amendment' : 'Save report'}
      </button>
    </div>
  );
}

function OrderCard({ item, stage }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState(null);
  const detail = useQuery({
    queryKey: ['imaging-order', item.id],
    queryFn: () => api.get(`/imaging-orders/${item.id}`),
    enabled: open,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['imaging-worklist'] });
    qc.invalidateQueries({ queryKey: ['imaging-order', item.id] });
    setMode(null);
  };
  const act = useMutation({
    mutationFn: ({ path, body }) => api.post(`/imaging-orders/${item.id}/${path}`, body ?? {}),
    onSuccess: refresh,
  });
  const upload = useMutation({
    mutationFn: (file) => api.upload(`/imaging-orders/${item.id}/attachments`, file),
    onSuccess: refresh,
  });
  const o = detail.data;
  return (
    <li className="px-4 py-3">
      <button
        className="flex w-full flex-wrap items-center gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-mono text-sm">{item.orderNumber}</span>
        <Badge tone={IMAGING_TONE[item.status]}>{item.status}</Badge>
        {item.priority !== 'routine' && <Badge tone="red">{item.priority}</Badge>}
        {item.overdue && <Badge tone="red">overdue</Badge>}
        <span className="font-medium">{item.study}</span>
        <span>
          {item.patient} <span className="font-mono text-xs text-slate-600">{item.mrn}</span>
        </span>
        <span className="ml-auto text-xs text-slate-600">
          {item.scheduledFor
            ? `booked ${formatDateTime(item.scheduledFor)}`
            : `ordered ${formatDateTime(item.orderedAt)}`}
        </span>
      </button>
      <p className="text-xs text-slate-700">Indication: {item.clinicalIndication}</p>
      {open && (
        <div className="mt-2 space-y-2">
          {detail.isPending && <Spinner rows={2} />}
          {o && (
            <>
              {o.study.preparation && <p className="text-xs text-amber-800">Preparation: {o.study.preparation}</p>}
              {['schedule', 'perform'].includes(stage) && (
                <div className="flex flex-wrap items-end gap-2">
                  <Can perm="imaging.schedule">
                    <Field label="Book for">
                      <input
                        className="input"
                        type="datetime-local"
                        value={when}
                        onChange={(e) => setWhen(e.target.value)}
                      />
                    </Field>
                    <button
                      className="btn-secondary min-h-10"
                      disabled={!when || act.isPending}
                      onClick={() =>
                        act.mutate({ path: 'schedule', body: { scheduledFor: new Date(when).toISOString() } })
                      }
                    >
                      {o.status === 'scheduled' ? 'Rebook' : 'Book'}
                    </button>
                  </Can>
                  <Can perm="imaging.perform">
                    <Field label="Technique notes (optional)">
                      <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    </Field>
                    <button
                      className="btn-primary min-h-10"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ path: 'perform', body: { techniqueNotes: notes || null } })}
                    >
                      Mark as performed
                    </button>
                  </Can>
                </div>
              )}
              {o.accessionNumber && <p className="text-xs">Accession {o.accessionNumber}</p>}
              {stage === 'report' && (
                <Can perm="imaging.report">
                  {o.status === 'reported' && mode !== 'edit' ? (
                    <>
                      <ImagingReport o={o} />
                      <div className="flex gap-2">
                        <button
                          className="btn-primary min-h-9"
                          disabled={act.isPending}
                          onClick={() => act.mutate({ path: 'release' })}
                        >
                          Release report
                        </button>
                        <button className="btn-secondary min-h-9" onClick={() => setMode('edit')}>
                          Edit
                        </button>
                      </div>
                    </>
                  ) : (
                    <ReportEditor o={o} onDone={refresh} />
                  )}
                </Can>
              )}
              {stage === 'done' && (
                <>
                  <ImagingReport o={o} />
                  <Can perm="imaging.report">
                    {mode === 'amend' ? (
                      <ReportEditor o={o} amend onDone={refresh} />
                    ) : (
                      <button className="btn-secondary min-h-9" onClick={() => setMode('amend')}>
                        Amend report
                      </button>
                    )}
                  </Can>
                </>
              )}
              {!['ordered', 'scheduled', 'cancelled'].includes(o.status) && (
                <Can perm={['imaging.perform', 'imaging.report']}>
                  <label className="block text-sm">
                    <span className="label">Attach a PDF or image</span>
                    <input
                      type="file"
                      accept="application/pdf,image/png,image/jpeg"
                      onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])}
                    />
                  </label>
                  {o.attachments.length > 0 && (
                    <p className="text-xs">Attached: {o.attachments.map((a) => a.fileName).join(', ')}</p>
                  )}
                </Can>
              )}
              <ErrorMessage error={act.error ?? upload.error} />
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Radiology worklist: book, perform, report and release. */
export default function Imaging() {
  const [params, setParams] = useSearchParams();
  const stage = STAGES.some(([s]) => s === params.get('stage')) ? params.get('stage') : 'perform';
  const [modality, setModality] = useState('');
  const list = useQuery({
    queryKey: ['imaging-worklist', stage, modality],
    queryFn: () => api.get(`/imaging/worklist${qs({ stage, modality: modality || undefined })}`),
    refetchInterval: 20_000,
  });
  return (
    <>
      <PageHeader
        title="Imaging"
        description="Book, perform, report and release. Every request carries its clinical indication."
      />
      <div role="tablist" aria-label="Stage" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 pb-2">
        {STAGES.map(([s, l]) => (
          <button
            key={s}
            role="tab"
            aria-selected={stage === s}
            aria-current={stage === s ? 'page' : undefined}
            className={`nav-item rounded-md px-3 py-1.5 text-sm font-medium ${stage === s ? 'text-brand-800' : 'text-slate-700 hover:bg-white'}`}
            onClick={() => setParams({ stage: s })}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="mb-3 max-w-xs">
        <Field label="Modality">
          <select className="input" value={modality} onChange={(e) => setModality(e.target.value)}>
            <option value="">All</option>
            {MODALITIES.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      </div>
      <section className="card" aria-label="Imaging worklist">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <ErrorMessage error={list.error} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="Nothing here" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.data.map((o) => (
              <OrderCard key={o.id} item={o} stage={stage} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

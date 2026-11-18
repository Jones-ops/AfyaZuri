import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { CONSENT_TYPES } from '@afyazuri/shared';
import { api } from '../api.js';
import { Can } from '../auth.jsx';
import CheckIn from '../components/CheckIn.jsx';
import PatientBanner from '../components/PatientBanner.jsx';
import PatientFields, { ID_FIELDS, fromPatient, issueMap, toPatientBody } from '../components/PatientForm.jsx';
import { Alert, Badge, ErrorMessage, Field, PageHeader, formatDateTime, PageSkeleton } from '../components/ui.jsx';

const ID_LABEL = Object.fromEntries(ID_FIELDS);
const CONSENT_LABEL = {
  data_processing: 'Processing for care',
  share_with_payer: 'Share with payer (claims)',
  share_for_referral: 'Share for referral',
  sms: 'SMS notifications',
};

export function usePatient(id) {
  return useQuery({
    queryKey: ['patient', id],
    queryFn: () => api.get(`/patients/${id}`),
    retry: false,
    enabled: !!id,
  });
}

export default function PatientDetail() {
  const { id } = useParams();
  const location = useLocation();
  const q = usePatient(id);
  const [editing, setEditing] = useState(false);

  if (q.isPending) return <PageSkeleton />;
  if (q.error?.code === 'PATIENT_MERGED')
    return <Navigate to={`/patients/${q.error.details.survivorId}`} replace state={{ merged: true }} />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const p = q.data;

  return (
    <>
      <PatientBanner patient={p} />
      <CheckIn patient={p} />
      {location.state?.registered && (
        <div className="mb-3">
          <Alert kind="success">
            Registered with MRN <strong className="font-mono">{p.mrn}</strong>.{' '}
            <Link className="underline" to={`/patients/${p.id}/card`}>
              Print patient card
            </Link>
          </Alert>
        </div>
      )}
      {location.state?.merged && (
        <div className="mb-3">
          <Alert kind="info">The record you opened was merged into this one.</Alert>
        </div>
      )}
      <PageHeader
        title="Patient record"
        actions={
          <>
            <Can perm="emr.read">
              <Link to={`/patients/${p.id}/chart`} className="btn-primary">
                Clinical chart
              </Link>
            </Can>
            <Link to={`/patients/${p.id}/card`} className="btn-secondary">
              Patient card
            </Link>
            <Can perm="patients.update">
              {!editing && (
                <button className="btn-secondary" onClick={() => setEditing(true)}>
                  Edit details
                </button>
              )}
            </Can>
          </>
        }
      />
      {editing ? <EditPatient patient={p} onDone={() => setEditing(false)} /> : <Details patient={p} />}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Payers patient={p} />
        <Consents patient={p} />
      </div>
      <Can perm={['patients.merge', 'patients.restrict']}>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Can perm="patients.restrict">
            <Restrict patient={p} />
          </Can>
          <Can perm="patients.merge">
            <Merge patient={p} />
          </Can>
        </div>
      </Can>
    </>
  );
}

function Row({ label, children }) {
  return (
    <>
      <dt className="text-slate-600">{label}</dt>
      <dd className="min-w-0 break-words">{children || '—'}</dd>
    </>
  );
}

function Details({ patient: p }) {
  return (
    <section className="card p-4">
      <dl className="grid grid-cols-[minmax(8rem,auto),1fr] gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto,1fr,auto,1fr]">
        <Row label="Date of birth">
          {p.dateOfBirth} {p.dobEstimated && <Badge>estimated</Badge>}
        </Row>
        <Row label="Phone">{p.phone}</Row>
        {p.identifiers.map((i) => (
          <Row key={i.id} label={ID_LABEL[i.type] ?? i.type}>
            <span className="font-mono">{i.value}</span>
          </Row>
        ))}
        <Row label="Email">{p.email}</Row>
        <Row label="Village / estate">{p.village}</Row>
        <Row label="Occupation">{p.occupation}</Row>
        <Row label="Marital status">{p.maritalStatus}</Row>
        <Row label="Next of kin">
          {p.nextOfKin &&
            `${p.nextOfKin.name} (${p.nextOfKin.relationship})${p.nextOfKin.phone ? ` · ${p.nextOfKin.phone}` : ''}`}
        </Row>
        <Row label="Registered">{formatDateTime(p.createdAt)}</Row>
      </dl>
    </section>
  );
}

function EditPatient({ patient: p, onDone }) {
  const qc = useQueryClient();
  const form = useForm({ defaultValues: fromPatient(p) });
  const m = useMutation({
    mutationFn: (v) => api.patch(`/patients/${p.id}`, toPatientBody(v)),
    onSuccess: (data) => {
      qc.setQueryData(['patient', p.id], data);
      onDone();
    },
  });
  return (
    <form className="card space-y-6 p-4" onSubmit={form.handleSubmit((v) => m.mutate(v))} noValidate>
      <PatientFields form={form} issues={issueMap(m.error)} />
      <ErrorMessage error={m.error} />
      <div className="flex gap-2">
        <button className="btn-primary" disabled={m.isPending}>
          Save changes
        </button>
        <button type="button" className="btn-secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function usePatientMutation(patientId, fn) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data) => data?.id && qc.setQueryData(['patient', patientId], data),
  });
}

function Payers({ patient: p }) {
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api.get('/schemes'), staleTime: 10 * 60_000 });
  const [schemeId, setSchemeId] = useState('');
  const [member, setMember] = useState('');
  const add = usePatientMutation(p.id, () =>
    api.post(`/patients/${p.id}/payer-schemes`, { schemeId, memberNumber: member, isPrimary: true }),
  );
  const remove = usePatientMutation(p.id, (linkId) => api.delete(`/patients/${p.id}/payer-schemes/${linkId}`));
  return (
    <section className="card p-4">
      <h2 className="mb-2 font-semibold">Payer schemes</h2>
      {p.payerSchemes.length === 0 ? (
        <p className="text-sm text-slate-600">Cash / self-pay</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {p.payerSchemes.map((s) => (
            <li key={s.id}>
              <strong>{s.payerName}</strong> — {s.schemeName} · <span className="font-mono">{s.memberNumber}</span>
              {s.isPrimary && (
                <span className="ml-2">
                  <Badge tone="blue">primary</Badge>
                </span>
              )}
              <Can perm="patients.update">
                <button
                  className="ml-2 text-xs text-red-700 hover:underline"
                  onClick={() => remove.mutate(s.id)}
                  disabled={remove.isPending}
                >
                  Remove
                </button>
              </Can>
            </li>
          ))}
        </ul>
      )}
      <Can perm="patients.update">
        <form
          className="mt-3 grid gap-2 sm:grid-cols-[1fr,1fr,auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Add scheme">
            <select className="input" value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
              <option value="">Choose…</option>
              {schemes.data?.data
                .filter((s) => s.payerType !== 'cash')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.payerName} — {s.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Member number">
            <input className="input" value={member} onChange={(e) => setMember(e.target.value)} />
          </Field>
          <button className="btn-secondary" disabled={!schemeId || member.trim().length < 2 || add.isPending}>
            Add
          </button>
        </form>
        <ErrorMessage error={add.error || remove.error} />
      </Can>
    </section>
  );
}

function Consents({ patient: p }) {
  const m = usePatientMutation(p.id, (body) => api.post(`/patients/${p.id}/consents`, body));
  const current = Object.fromEntries(p.consents.map((c) => [c.consentType, c]));
  return (
    <section className="card p-4">
      <h2 className="mb-2 font-semibold">Consent</h2>
      <ul className="space-y-2 text-sm">
        {CONSENT_TYPES.map((t) => {
          const c = current[t];
          return (
            <li key={t} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {CONSENT_LABEL[t]}:{' '}
                {c ? (
                  <Badge tone={c.granted ? 'green' : 'red'}>{c.granted ? 'given' : 'refused / withdrawn'}</Badge>
                ) : (
                  <Badge>not recorded</Badge>
                )}
                {c && (
                  <span className="ml-2 text-xs text-slate-600">
                    v{c.version} · {formatDateTime(c.capturedAt)}
                  </span>
                )}
              </span>
              <Can perm="patients.consent.manage">
                <span className="flex gap-1">
                  <button
                    className="btn-secondary min-h-8 px-2 text-xs"
                    onClick={() => m.mutate({ consentType: t, granted: true, method: 'verbal' })}
                  >
                    Record given
                  </button>
                  <button
                    className="btn-secondary min-h-8 px-2 text-xs"
                    onClick={() => m.mutate({ consentType: t, granted: false, method: 'verbal' })}
                  >
                    Withdrawn
                  </button>
                </span>
              </Can>
            </li>
          );
        })}
      </ul>
      <ErrorMessage error={m.error} />
    </section>
  );
}

function Restrict({ patient: p }) {
  const [reason, setReason] = useState('');
  const m = usePatientMutation(p.id, () =>
    api.post(`/patients/${p.id}/restrict`, { restricted: !p.isRestricted, reason }),
  );
  return (
    <section className="card p-4">
      <h2 className="mb-1 font-semibold">Restricted record</h2>
      <p className="mb-2 text-sm text-slate-600">
        {p.isRestricted
          ? `Restricted: ${p.restrictedReason ?? ''}. Clinical staff need emergency access, which is logged and reviewed.`
          : 'For VIPs or sensitive cases. Clinical access then requires break-the-glass.'}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <label className="min-w-56 flex-1">
          <span className="label">Reason</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button className="btn-secondary" disabled={reason.trim().length < 10 || m.isPending}>
          {p.isRestricted ? 'Remove restriction' : 'Restrict record'}
        </button>
      </form>
      <ErrorMessage error={m.error} />
    </section>
  );
}

function Merge({ patient: p }) {
  const qc = useQueryClient();
  const [other, setOther] = useState('');
  const [reason, setReason] = useState('');
  const history = useQuery({ queryKey: ['merges', p.id], queryFn: () => api.get(`/patients/${p.id}/merges`) });
  const lookup = useQuery({
    queryKey: ['patients', other.trim()],
    queryFn: () => api.get(`/patients?q=${encodeURIComponent(other.trim())}`),
    enabled: other.trim().length >= 3,
  });
  const [target, setTarget] = useState(null);
  const merge = useMutation({
    mutationFn: () => api.post('/patients/merge', { survivorId: p.id, mergedId: target.id, reason }),
    onSuccess: () => {
      setTarget(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['patient', p.id] });
      qc.invalidateQueries({ queryKey: ['merges', p.id] });
    },
  });
  const unmerge = useMutation({
    mutationFn: ({ mergeId, why }) => api.post(`/patient-merges/${mergeId}/unmerge`, { reason: why }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['patient', p.id] });
      qc.invalidateQueries({ queryKey: ['merges', p.id] });
    },
  });
  const candidates = (lookup.data?.data ?? []).filter((x) => x.id !== p.id);

  return (
    <section className="card p-4">
      <h2 className="mb-1 font-semibold">Merge a duplicate into this record</h2>
      <p className="mb-2 text-sm text-slate-600">
        All visits, notes and other records of the duplicate move here. This can be undone.
      </p>
      <Field label="Find the duplicate (name, MRN, phone or ID)">
        <input className="input" value={other} onChange={(e) => setOther(e.target.value)} />
      </Field>
      {candidates.length > 0 && !target && (
        <ul className="mt-2 space-y-1 text-sm">
          {candidates.slice(0, 5).map((c) => (
            <li key={c.id}>
              <button className="text-left text-brand-800 hover:underline" onClick={() => setTarget(c)}>
                {c.fullName} · {c.age} · <span className="font-mono">{c.mrn}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {target && (
        <form
          className="mt-3 space-y-2 rounded border border-amber-300 bg-amber-50 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            merge.mutate();
          }}
        >
          <p className="text-sm">
            Merge <strong>{target.fullName}</strong> (<span className="font-mono">{target.mrn}</span>) into{' '}
            <strong>{p.fullName}</strong> (<span className="font-mono">{p.mrn}</span>)?
          </p>
          <Field label="Reason">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <button className="btn-danger" disabled={reason.trim().length < 10 || merge.isPending}>
              Merge records
            </button>
            <button type="button" className="btn-secondary" onClick={() => setTarget(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <ErrorMessage error={merge.error || unmerge.error} />
      {history.data?.data.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-semibold">Merge history</h3>
          <ul className="space-y-1 text-sm">
            {history.data.data.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {h.mergedName} (<span className="font-mono">{h.mergedMrn}</span>) →{' '}
                  <span className="font-mono">{h.survivorMrn}</span> · {formatDateTime(h.mergedAt)} by {h.mergedBy}
                  {h.unmergedAt && <Badge>reversed</Badge>}
                </span>
                {!h.unmergedAt && (
                  <button
                    className="text-sm text-red-700 hover:underline"
                    onClick={() => {
                      const why = window.prompt('Reason for reversing this merge');
                      if (why) unmerge.mutate({ mergeId: h.id, why });
                    }}
                  >
                    Unmerge
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

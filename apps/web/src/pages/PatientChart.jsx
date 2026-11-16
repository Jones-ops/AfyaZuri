import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ALLERGY_CATEGORIES, ALLERGY_SEVERITY } from '@afyazuri/shared';
import { api } from '../api.js';
import { Can } from '../auth.jsx';
import { FlagList } from '../components/emr/VitalsPanel.jsx';
import { Note } from '../components/emr/NotesPanel.jsx';
import PatientBanner from '../components/PatientBanner.jsx';
import {
  Alert,
  Badge,
  EmptyState,
  ErrorMessage,
  Field,
  PageHeader,
  Spinner,
  formatDateTime,
} from '../components/ui.jsx';
import { usePatient } from './PatientDetail.jsx';

/** The patient's clinical chart: allergies, problems and the full timeline. */
export default function PatientChart() {
  const { id } = useParams();
  const patient = usePatient(id);
  const canView = !!patient.data?.clinical?.canView;
  const summary = useQuery({
    queryKey: ['summary', id],
    queryFn: () => api.get(`/patients/${id}/clinical-summary`),
    enabled: canView,
  });
  const tl = useInfiniteQuery({
    queryKey: ['timeline', id],
    queryFn: ({ pageParam }) =>
      api.get(`/patients/${id}/timeline${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined,
    getNextPageParam: (l) => l.nextBefore ?? undefined,
    enabled: canView,
  });
  const qc = useQueryClient();
  const refresh = () => ['summary', 'timeline', 'patient'].forEach((k) => qc.invalidateQueries({ queryKey: [k, id] }));

  if (patient.isPending) return <Spinner />;
  if (patient.error) return <ErrorMessage error={patient.error} />;
  const p = patient.data;
  const events = tl.data?.pages.flatMap((x) => x.data) ?? [];

  return (
    <>
      <PatientBanner patient={p} />
      <PageHeader
        title="Clinical chart"
        actions={
          <Link to={`/patients/${id}`} className="btn-secondary">
            Patient record
          </Link>
        }
      />
      {!canView ? (
        <Alert kind="warn">
          {p.clinical.reason === 'restricted'
            ? 'This record is restricted. Use emergency access in the banner above if you need it.'
            : 'Your role does not include access to clinical records.'}
        </Alert>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem),1fr]">
          <div className="space-y-4">
            <Allergies patientId={id} allergies={summary.data?.allergies ?? []} onChange={refresh} />
            <Problems patientId={id} problems={summary.data?.problems ?? []} onChange={refresh} />
          </div>
          <section className="card p-4" aria-labelledby="tl-h">
            <h2 id="tl-h" className="mb-3 font-semibold">
              Timeline
            </h2>
            {tl.isPending ? (
              <Spinner />
            ) : tl.error ? (
              <ErrorMessage error={tl.error} />
            ) : events.length === 0 ? (
              <EmptyState title="Nothing recorded yet" />
            ) : (
              <ol className="space-y-3">
                {events.map((e) => (
                  <TimelineItem key={`${e.kind}-${e.data.id ?? e.encounterId}`} e={e} />
                ))}
              </ol>
            )}
            {tl.hasNextPage && (
              <button
                className="btn-secondary mt-3"
                onClick={() => tl.fetchNextPage()}
                disabled={tl.isFetchingNextPage}
              >
                Older entries
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}

const KIND_LABEL = {
  encounter: 'Visit',
  vitals: 'Vitals',
  note: 'Note',
  diagnosis: 'Diagnosis',
  allergy: 'Allergy',
  problem: 'Problem',
};

function TimelineItem({ e }) {
  const d = e.data;
  let body;
  if (e.kind === 'encounter')
    body = (
      <Link to={`/encounters/${e.encounterId}`} className="text-brand-800 hover:underline">
        {d.type} visit ({d.status})
      </Link>
    );
  else if (e.kind === 'vitals')
    body = (
      <>
        <span className={d.enteredInError ? 'line-through' : ''}>
          {[
            d.systolic && `BP ${d.systolic}/${d.diastolic}`,
            d.pulse && `P ${d.pulse}`,
            d.temperatureC && `T ${d.temperatureC}°C`,
            d.spo2 && `SpO₂ ${d.spo2}%`,
            d.weightKg && `Wt ${d.weightKg} kg`,
            d.bmi && `BMI ${d.bmi}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {!d.enteredInError && <FlagList flags={d.flags} />}
      </>
    );
  else if (e.kind === 'note') body = <Note note={d} mine={false} />;
  else if (e.kind === 'diagnosis')
    body = (
      <span className={d.enteredInError ? 'line-through' : ''}>
        <span className="font-mono font-semibold">{d.icdCode}</span> {d.description} · {d.certainty}
      </span>
    );
  else if (e.kind === 'allergy')
    body = (
      <span>
        {d.allergen} ({d.severity.replace('_', '-')})
      </span>
    );
  else body = <span>{d.description}</span>;

  return (
    <li className="grid grid-cols-[6.5rem,1fr] gap-3 text-sm">
      <div>
        <Badge>{KIND_LABEL[e.kind]}</Badge>
        <div className="mt-1 text-xs text-slate-600">{formatDateTime(e.at)}</div>
      </div>
      <div className="min-w-0">
        {e.kind === 'note' ? <ul>{body}</ul> : body}
        {d.enteredInError && e.kind !== 'note' && (
          <p className="text-xs text-red-700">Entered in error: {d.enteredInError.reason}</p>
        )}
      </div>
    </li>
  );
}

function Allergies({ patientId, allergies, onChange }) {
  const [form, setForm] = useState({ category: 'drug', allergen: '', severity: 'moderate', reaction: '' });
  const add = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/allergies`, form),
    onSuccess: () => {
      setForm({ ...form, allergen: '', reaction: '' });
      onChange();
    },
  });
  const status = useMutation({
    mutationFn: ({ id, s }) => api.patch(`/allergies/${id}`, { status: s }),
    onSuccess: onChange,
  });
  return (
    <section className="card p-4" aria-labelledby="al-h">
      <h2 id="al-h" className="mb-2 font-semibold">
        Allergies
      </h2>
      {allergies.length === 0 ? (
        <p className="text-sm text-slate-600">No allergies recorded.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {allergies.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2">
              <span className={a.status === 'inactive' ? 'text-slate-500 line-through' : ''}>
                <strong>{a.allergen}</strong> · {a.severity.replace('_', '-')}
                {a.reaction && ` · ${a.reaction}`}
              </span>
              <Can perm="emr.allergies.write">
                <button
                  className="text-xs text-brand-800 hover:underline"
                  onClick={() => status.mutate({ id: a.id, s: a.status === 'active' ? 'inactive' : 'active' })}
                >
                  {a.status === 'active' ? 'Mark inactive' : 'Reactivate'}
                </button>
              </Can>
            </li>
          ))}
        </ul>
      )}
      <Can perm="emr.allergies.write">
        <form
          className="mt-3 grid grid-cols-2 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label="Allergen">
            <input
              className="input"
              value={form.allergen}
              onChange={(e) => setForm({ ...form, allergen: e.target.value })}
            />
          </Field>
          <Field label="Type">
            <select
              className="input"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {ALLERGY_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select
              className="input"
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
            >
              {ALLERGY_SEVERITY.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', '-')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reaction">
            <input
              className="input"
              value={form.reaction}
              onChange={(e) => setForm({ ...form, reaction: e.target.value })}
            />
          </Field>
          <div className="col-span-2">
            <ErrorMessage error={add.error} />
            <button className="btn-secondary" disabled={form.allergen.trim().length < 2 || add.isPending}>
              Add allergy
            </button>
          </div>
        </form>
      </Can>
    </section>
  );
}

function Problems({ patientId, problems, onChange }) {
  const [description, setDescription] = useState('');
  const add = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/problems`, { description }),
    onSuccess: () => {
      setDescription('');
      onChange();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, status }) => api.patch(`/problems/${id}`, { status }),
    onSuccess: onChange,
  });
  return (
    <section className="card p-4" aria-labelledby="pr-h">
      <h2 id="pr-h" className="mb-2 font-semibold">
        Problem list
      </h2>
      {problems.length === 0 ? (
        <p className="text-sm text-slate-600">No problems recorded.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {problems.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-2">
              <span className={x.status === 'resolved' ? 'text-slate-500 line-through' : ''}>
                {x.icdCode && <span className="font-mono">{x.icdCode} </span>}
                {x.description}
              </span>
              <Can perm="emr.allergies.write">
                <button
                  className="text-xs text-brand-800 hover:underline"
                  onClick={() => update.mutate({ id: x.id, status: x.status === 'active' ? 'resolved' : 'active' })}
                >
                  {x.status === 'active' ? 'Resolve' : 'Reopen'}
                </button>
              </Can>
            </li>
          ))}
        </ul>
      )}
      <Can perm="emr.allergies.write">
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <label className="flex-1">
            <span className="sr-only">New problem</span>
            <input
              className="input"
              placeholder="e.g. Hypertension"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <button className="btn-secondary" disabled={description.trim().length < 2 || add.isPending}>
            Add
          </button>
        </form>
        <ErrorMessage error={add.error} />
      </Can>
    </section>
  );
}

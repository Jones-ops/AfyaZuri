import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import PatientFields, { issueMap, toPatientBody } from '../components/PatientForm.jsx';
import { Alert, Badge, ErrorMessage, Field, PageHeader } from '../components/ui.jsx';

export default function PatientRegister() {
  const nav = useNavigate();
  const form = useForm({
    defaultValues: { ageMode: 'dob', sex: '', schemeId: '', consentProcessing: true, consentSms: false },
  });
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api.get('/schemes'), staleTime: 10 * 60_000 });
  const clientId = useRef(crypto.randomUUID()); // makes a retried submit (e.g. after a timeout) idempotent
  const [duplicates, setDuplicates] = useState(null);
  const [override, setOverride] = useState('');

  const submit = useMutation({
    mutationFn: (v) => {
      const body = toPatientBody(v);
      body.clientId = clientId.current;
      if (v.schemeId) body.payerScheme = { schemeId: v.schemeId, memberNumber: v.memberNumber, isPrimary: true };
      body.consents = [
        { consentType: 'data_processing', granted: !!v.consentProcessing, method: 'verbal' },
        { consentType: 'sms', granted: !!v.consentSms, method: 'verbal' },
      ];
      if (v.override) body.duplicateOverrideReason = v.override;
      return api.post('/patients', body);
    },
    onSuccess: (p) => nav(`/patients/${p.id}`, { replace: true, state: { registered: true } }),
    onError: (e) => {
      if (e.code === 'POSSIBLE_DUPLICATE') setDuplicates(e.details.candidates);
    },
  });
  const issues = issueMap(submit.error);
  const schemeId = form.watch('schemeId');
  const scheme = schemes.data?.data.find((s) => s.id === schemeId);

  return (
    <>
      <PageHeader title="Register patient" description="Required: name, sex, and a date of birth or estimated age." />
      <form className="space-y-6" onSubmit={form.handleSubmit((v) => submit.mutate(v))} noValidate>
        <div className="card space-y-6 p-4">
          <PatientFields form={form} issues={issues} />
          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="mb-2 font-semibold">Payer</legend>
            <Field label="Scheme" hint="Leave as Cash for self-paying patients">
              <select className="input" {...form.register('schemeId')}>
                <option value="">Cash / self-pay</option>
                {schemes.data?.data
                  .filter((s) => s.payerType !== 'cash')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.payerName} — {s.name}
                    </option>
                  ))}
              </select>
            </Field>
            {scheme && (
              <Field
                label={scheme.payerType === 'sha' ? 'SHA member number' : 'Member number'}
                required
                error={issues['payerScheme.memberNumber']}
              >
                <input className="input" {...form.register('memberNumber')} />
              </Field>
            )}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-2 font-semibold">Consent</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" {...form.register('consentProcessing')} />
              Patient was told how their information is used for their care and agrees to it being processed.
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" {...form.register('consentSms')} />
              Patient agrees to receive SMS (appointment reminders, results ready).
            </label>
          </fieldset>
        </div>

        {duplicates && (
          <section className="card border-amber-300 p-4" aria-live="polite">
            <h2 className="font-semibold text-amber-900">This patient may already be registered</h2>
            <p className="mb-3 text-sm text-slate-700">Open the existing record if it is the same person.</p>
            <ul className="space-y-2">
              {duplicates.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 p-2 text-sm"
                >
                  <span>
                    <strong>{d.fullName}</strong> · {d.age} · {d.sex} · <span className="font-mono">{d.mrn}</span>
                    {d.phoneMasked && <span className="text-slate-600"> · {d.phoneMasked}</span>}
                    <span className="ml-2 inline-flex flex-wrap gap-1">
                      {d.reasons.map((r) => (
                        <Badge key={r} tone={d.score >= 90 ? 'red' : 'amber'}>
                          {r}
                        </Badge>
                      ))}
                    </span>
                  </span>
                  <Link to={`/patients/${d.id}`} className="btn-secondary">
                    Open this record
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4 grid gap-2 sm:grid-cols-[1fr,auto] sm:items-end">
              <Field
                label="Reason for creating a new record anyway"
                hint="e.g. different person — confirmed with ID card"
              >
                <input className="input" value={override} onChange={(e) => setOverride(e.target.value)} />
              </Field>
              <button
                type="button"
                className="btn-danger"
                disabled={override.trim().length < 10 || submit.isPending}
                onClick={form.handleSubmit((v) => submit.mutate({ ...v, override }))}
              >
                Create new anyway
              </button>
            </div>
          </section>
        )}

        {submit.error && submit.error.code !== 'POSSIBLE_DUPLICATE' && <ErrorMessage error={submit.error} />}
        {submit.isPending && <Alert kind="info">Saving…</Alert>}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={submit.isPending}>
            Register
          </button>
          <Link to="/patients" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}

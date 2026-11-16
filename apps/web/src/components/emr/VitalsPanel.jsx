import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { useForm } from 'react-hook-form';
import { bmi, evaluateVitals } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Can } from '../../auth.jsx';
import { Badge, ErrorMessage, Field, formatDateTime } from '../ui.jsx';

const LEVEL_TONE = { critical: 'red', high: 'amber', low: 'amber' };
export const FlagList = ({ flags }) =>
  flags?.length ? (
    <ul className="flex flex-wrap gap-1" aria-label="Abnormal values">
      {flags.map((f, i) => (
        <li key={i}>
          <Badge tone={LEVEL_TONE[f.level]}>{f.message}</Badge>
        </li>
      ))}
    </ul>
  ) : null;

const FIELDS = [
  ['systolic', 'BP systolic', 'mmHg'],
  ['diastolic', 'BP diastolic', 'mmHg'],
  ['pulse', 'Pulse', '/min'],
  ['temperatureC', 'Temperature', '°C', '0.1'],
  ['respRate', 'Resp. rate', '/min'],
  ['spo2', 'SpO₂', '%'],
  ['weightKg', 'Weight', 'kg', '0.1'],
  ['heightCm', 'Height', 'cm', '0.1'],
];

/**
 * Record triage vitals with live BMI and abnormal-value preview (the same rules
 * the server applies).
 * @param {{encounterId: string, ageMonths: number, vitals: any[], onChange: () => void}} props
 */
export default function VitalsPanel({ encounterId, ageMonths, vitals, onChange }) {
  const form = useForm();
  const clientId = useRef(crypto.randomUUID());
  const values = form.watch();
  const preview = evaluateVitals(values, { ageMonths });
  const liveBmi = bmi(Number(values.weightKg) || null, Number(values.heightCm) || null);
  const save = useMutation({
    mutationFn: (v) => api.post(`/encounters/${encounterId}/vitals`, { ...v, clientId: clientId.current }),
    onSuccess: () => {
      clientId.current = crypto.randomUUID();
      form.reset();
      onChange();
    },
  });
  const markError = useMutation({
    mutationFn: ({ id, reason }) => api.post(`/clinical/vitals/${id}/entered-in-error`, { reason }),
    onSuccess: onChange,
  });
  const underFive = ageMonths < 60;

  return (
    <section className="card p-4" aria-labelledby="vitals-h">
      <h2 id="vitals-h" className="mb-3 font-semibold">
        Vitals
      </h2>
      <Can perm="emr.vitals.write">
        <form className="space-y-3" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {FIELDS.map(([name, label, unit, step]) => (
              <Field key={name} label={`${label} (${unit})`}>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step={step ?? '1'}
                  {...form.register(name)}
                />
              </Field>
            ))}
            {underFive && (
              <Field label="MUAC (cm)" hint="6–59 months">
                <input className="input" type="number" inputMode="decimal" step="0.1" {...form.register('muacCm')} />
              </Field>
            )}
            <Field label="Pain (0–10)">
              <input
                className="input"
                type="number"
                min="0"
                max="10"
                inputMode="numeric"
                {...form.register('painScore')}
              />
            </Field>
          </div>
          <Field label="Notes">
            <input className="input" {...form.register('notes')} />
          </Field>
          <div className="flex flex-wrap items-center gap-2" aria-live="polite">
            {liveBmi && <Badge tone="slate">BMI {liveBmi}</Badge>}
            <FlagList flags={preview} />
          </div>
          <ErrorMessage error={save.error} />
          <button className="btn-primary" disabled={save.isPending}>
            Save vitals
          </button>
        </form>
      </Can>
      {vitals.length > 0 && (
        <ul className="mt-4 space-y-2 text-sm">
          {[...vitals].reverse().map((v) => (
            <li key={v.id} className={`rounded border border-slate-200 p-2 ${v.enteredInError ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={v.enteredInError ? 'line-through' : ''}>
                  {[
                    v.systolic && `BP ${v.systolic}/${v.diastolic}`,
                    v.pulse && `P ${v.pulse}`,
                    v.temperatureC && `T ${v.temperatureC}°C`,
                    v.respRate && `RR ${v.respRate}`,
                    v.spo2 && `SpO₂ ${v.spo2}%`,
                    v.weightKg && `Wt ${v.weightKg} kg`,
                    v.heightCm && `Ht ${v.heightCm} cm`,
                    v.bmi && `BMI ${v.bmi}`,
                    v.muacCm && `MUAC ${v.muacCm} cm`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="text-xs text-slate-600">
                  {formatDateTime(v.recordedAt)} · {v.recordedBy?.name}
                </span>
              </div>
              {v.enteredInError ? (
                <p className="text-xs text-red-700">Entered in error: {v.enteredInError.reason}</p>
              ) : (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <FlagList flags={v.flags} />
                  <Can perm="emr.vitals.write">
                    <button
                      className="text-xs text-red-700 hover:underline"
                      onClick={() => {
                        const reason = window.prompt('Why is this entry wrong?');
                        if (reason) markError.mutate({ id: v.id, reason });
                      }}
                    >
                      Entered in error
                    </button>
                  </Can>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

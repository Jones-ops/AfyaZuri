import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FLAG_LABEL, flagFor } from '@afyazuri/shared';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Alert, Badge, ErrorMessage, Field, Spinner, formatDateTime } from '../ui.jsx';

const FLAG_TONE = { N: 'green', L: 'amber', H: 'amber', LL: 'red', HH: 'red', A: 'red' };

export function Flag({ flag }) {
  if (!flag || flag === 'N') return null;
  return <Badge tone={FLAG_TONE[flag]}>{FLAG_LABEL[flag]}</Badge>;
}

export function useItemResults(itemId) {
  return useQuery({ queryKey: ['lab-results', itemId], queryFn: () => api.get(`/lab-order-items/${itemId}/results`) });
}

function CultureView({ c }) {
  if (!c) return null;
  if (c.growth !== 'growth') return <span>{c.growth === 'no_growth' ? 'No growth' : 'Contaminated: repeat'}</span>;
  return (
    <span>
      <strong>{c.organism}</strong> {c.colonyCount}
      {c.sensitivities?.length > 0 && (
        <span className="block text-xs">{c.sensitivities.map((s) => `${s.antibiotic}: ${s.result}`).join(' · ')}</span>
      )}
    </span>
  );
}

const show = (v) => (v == null ? '—' : String(v));

/** Read-only results table (values, units, ranges, flags, earlier versions). */
export function ResultTable({ data }) {
  return (
    <div className="space-y-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-600">
            <th className="text-left">Test</th>
            <th className="text-left">Result</th>
            <th className="text-left">Range</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.components.map((c) => (
            <tr key={c.id} className={c.current?.critical ? 'font-semibold text-red-800' : ''}>
              <td className="py-0.5">{c.name}</td>
              <td className="py-0.5 tabular-nums">
                {c.resultType === 'culture' ? (
                  <CultureView c={c.current?.culture} />
                ) : (
                  <>
                    {show(c.current?.value)} {c.current && c.unit}
                  </>
                )}
                {c.history.length > 0 && (
                  <span className="block text-xs font-normal text-slate-500">
                    was {c.history.map((h) => `${show(h.value)} (v${h.version})`).join(', ')}
                  </span>
                )}
              </td>
              <td className="py-0.5 text-xs text-slate-600">{c.current?.rangeText ?? c.rangeText ?? ''}</td>
              <td className="py-0.5">
                <Flag flag={c.current?.flag} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.comment && <p className="text-xs text-slate-700">Comment: {data.comment}</p>}
      {data.amended && (
        <p className="text-xs text-amber-800">
          Amended:{' '}
          {data.verifications
            .filter((v) => v.action === 'amended')
            .map((v) => `v${v.version} by ${v.by}, ${formatDateTime(v.at)} — ${v.reason}`)
            .join('; ')}
        </p>
      )}
    </div>
  );
}

function CultureInput({ value, onChange }) {
  const c = value ?? { growth: 'no_growth', organism: '', colonyCount: '', sensitivities: [] };
  const set = (patch) => onChange({ ...c, ...patch });
  return (
    <div className="space-y-2">
      <select className="input" aria-label="Growth" value={c.growth} onChange={(e) => set({ growth: e.target.value })}>
        <option value="no_growth">No growth</option>
        <option value="growth">Growth</option>
        <option value="contaminated">Contaminated (repeat)</option>
      </select>
      {c.growth === 'growth' && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="input"
              aria-label="Organism"
              placeholder="Organism"
              value={c.organism}
              onChange={(e) => set({ organism: e.target.value })}
            />
            <input
              className="input"
              aria-label="Colony count"
              placeholder="Colony count"
              value={c.colonyCount}
              onChange={(e) => set({ colonyCount: e.target.value })}
            />
          </div>
          {c.sensitivities.map((s, i) => (
            <div key={i} className="flex gap-2">
              <input
                className="input"
                aria-label={`Antibiotic ${i + 1}`}
                value={s.antibiotic}
                onChange={(e) =>
                  set({
                    sensitivities: c.sensitivities.map((x, j) => (j === i ? { ...x, antibiotic: e.target.value } : x)),
                  })
                }
              />
              <select
                className="input w-20"
                aria-label={`Result ${i + 1}`}
                value={s.result}
                onChange={(e) =>
                  set({
                    sensitivities: c.sensitivities.map((x, j) => (j === i ? { ...x, result: e.target.value } : x)),
                  })
                }
              >
                <option>S</option>
                <option>I</option>
                <option>R</option>
              </select>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary min-h-8 px-3 text-xs"
            onClick={() => set({ sensitivities: [...c.sensitivities, { antibiotic: '', result: 'S' }] })}
          >
            Add antibiotic
          </button>
        </>
      )}
    </div>
  );
}

/** Enter results (or amend released ones) with a live flag preview against the patient's range. */
export function ResultForm({ itemId, amend = false, onDone }) {
  const qc = useQueryClient();
  const r = useItemResults(itemId);
  const [vals, setVals] = useState({});
  const [comment, setComment] = useState(null);
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post(`/lab-order-items/${itemId}/${amend ? 'amend' : 'results'}`, {
        values: r.data.components.map((c) => {
          const v = vals[c.id] ?? (c.resultType === 'culture' ? c.current?.culture : c.current?.value);
          if (c.resultType === 'culture')
            return { componentId: c.id, culture: v ?? { growth: 'no_growth', sensitivities: [] } };
          if (c.resultType === 'text') return { componentId: c.id, text: v ?? '' };
          return {
            componentId: c.id,
            value: v === '' || v == null ? null : c.resultType === 'numeric' ? Number(v) : v,
          };
        }),
        comment: (comment ?? r.data.comment) || null,
        ...(amend ? { reason } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lab-results', itemId] });
      qc.invalidateQueries({ queryKey: ['lab-worklist'] });
      onDone?.();
    },
  });
  if (r.isPending) return <Spinner rows={2} />;
  if (r.error) return <ErrorMessage error={r.error} />;
  const issues = Object.fromEntries((m.error?.details?.issues ?? []).map((i) => [i.path, i.message]));
  return (
    <form
      className="space-y-2 rounded-md border border-slate-200 bg-white/70 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <h4 className="text-sm font-semibold">
        {amend ? 'Amend' : 'Results for'} {r.data.test.name}
      </h4>
      {r.data.components.map((c) => {
        const current = vals[c.id] ?? (c.resultType === 'culture' ? c.current?.culture : c.current?.value) ?? '';
        const preview =
          c.resultType === 'numeric' || c.resultType === 'options'
            ? flagFor(c, c.range, current === '' ? null : c.resultType === 'numeric' ? Number(current) : current)
            : null;
        const set = (v) => setVals({ ...vals, [c.id]: v });
        return (
          <div key={c.id} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-start">
            <div className="pt-2 text-sm">
              {c.name}
              {c.rangeText && (
                <span className="block text-xs text-slate-500">
                  ref {c.rangeText} {c.unit}
                </span>
              )}
            </div>
            <Field label={`${c.name}${c.unit ? ` (${c.unit})` : ''}`} error={issues[`values.${c.code}`]}>
              {c.resultType === 'numeric' ? (
                <input className="input" inputMode="decimal" value={current} onChange={(e) => set(e.target.value)} />
              ) : c.resultType === 'options' ? (
                <select className="input" value={current} onChange={(e) => set(e.target.value)}>
                  <option value="">Choose…</option>
                  {c.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : c.resultType === 'culture' ? (
                <CultureInput value={current || null} onChange={set} />
              ) : (
                <textarea className="input min-h-16 py-2" value={current} onChange={(e) => set(e.target.value)} />
              )}
            </Field>
            <div className="pt-7">{preview?.flag && <Flag flag={preview.flag} />}</div>
          </div>
        );
      })}
      <Field label="Comment (optional)">
        <input className="input" value={comment ?? r.data.comment ?? ''} onChange={(e) => setComment(e.target.value)} />
      </Field>
      {amend && (
        <Field label="Reason for amendment (required)">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      <ErrorMessage error={m.error} />
      <button className="btn-primary min-h-9" disabled={m.isPending || (amend && reason.trim().length < 5)}>
        {amend ? 'Release amendment' : 'Save results'}
      </button>
    </form>
  );
}

/** Results waiting for verification, with the verify button (never for your own entry). */
export function VerifyPanel({ itemId }) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const r = useItemResults(itemId);
  const v = useMutation({
    mutationFn: () => api.post(`/lab-order-items/${itemId}/verify`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lab-results', itemId] });
      qc.invalidateQueries({ queryKey: ['lab-worklist'] });
    },
  });
  if (r.isPending) return <Spinner rows={2} />;
  if (r.error) return <ErrorMessage error={r.error} />;
  const mine = r.data.enteredById === me.user.id;
  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white/70 p-3">
      <h4 className="text-sm font-semibold">{r.data.test.name}</h4>
      {r.data.critical && <Alert>Critical value: the ordering clinician is alerted when you release it.</Alert>}
      <ResultTable data={r.data} />
      {mine ? (
        <p className="text-xs text-slate-600">You entered these results; someone else must verify them.</p>
      ) : (
        <button className="btn-primary min-h-9" disabled={v.isPending} onClick={() => v.mutate()}>
          Verify and release
        </button>
      )}
      <ErrorMessage error={v.error} />
    </div>
  );
}

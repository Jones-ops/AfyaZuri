import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Can } from '../../auth.jsx';
import { Badge, ErrorMessage } from '../ui.jsx';

/** ICD-11 coded diagnoses for a visit, with type-ahead code search. */
export default function DiagnosesPanel({ encounterId, diagnoses, onChange }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [rank, setRank] = useState('primary');
  const [certainty, setCertainty] = useState('provisional');
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ['icd', term],
    queryFn: () => api.get(`/icd?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });
  const add = useMutation({
    mutationFn: (code) => api.post(`/encounters/${encounterId}/diagnoses`, { icdCode: code, rank, certainty }),
    onSuccess: () => {
      setQ('');
      setRank('secondary');
      onChange();
    },
  });
  const markError = useMutation({
    mutationFn: ({ id, reason }) => api.post(`/clinical/diagnoses/${id}/entered-in-error`, { reason }),
    onSuccess: onChange,
  });
  const active = diagnoses.filter((d) => !d.enteredInError);

  return (
    <section className="card p-4" aria-labelledby="dx-h">
      <h2 id="dx-h" className="mb-3 font-semibold">
        Diagnoses (ICD-11)
      </h2>
      {diagnoses.length > 0 && (
        <ul className="mb-3 space-y-1 text-sm">
          {diagnoses.map((d) => (
            <li
              key={d.id}
              className={`flex flex-wrap items-center justify-between gap-2 ${d.enteredInError ? 'opacity-60' : ''}`}
            >
              <span className={d.enteredInError ? 'line-through' : ''}>
                <span className="font-mono font-semibold">{d.icdCode}</span> {d.description}
                {d.icd10 && <span className="text-xs text-slate-600"> (ICD-10 {d.icd10})</span>}{' '}
                <Badge tone={d.rank === 'primary' ? 'teal' : 'slate'}>{d.rank}</Badge>{' '}
                <Badge tone={d.certainty === 'confirmed' ? 'green' : 'amber'}>{d.certainty}</Badge>
              </span>
              {!d.enteredInError && (
                <Can perm="emr.diagnoses.write">
                  <button
                    className="text-xs text-red-700 hover:underline"
                    onClick={() => {
                      const reason = window.prompt('Why is this diagnosis wrong?');
                      if (reason) markError.mutate({ id: d.id, reason });
                    }}
                  >
                    Entered in error
                  </button>
                </Can>
              )}
            </li>
          ))}
        </ul>
      )}
      <Can perm="emr.diagnoses.write">
        <div className="grid gap-2 sm:grid-cols-[1fr,auto,auto]">
          <label>
            <span className="label">Search ICD-11 (name or code)</span>
            <input
              className="input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. malaria, BA00"
            />
          </label>
          <label>
            <span className="label">Rank</span>
            <select
              className="input"
              value={active.length ? rank : 'primary'}
              onChange={(e) => setRank(e.target.value)}
            >
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
            </select>
          </label>
          <label>
            <span className="label">Certainty</span>
            <select className="input" value={certainty} onChange={(e) => setCertainty(e.target.value)}>
              <option value="provisional">Provisional</option>
              <option value="confirmed">Confirmed</option>
            </select>
          </label>
        </div>
        {search.data?.data.length > 0 && (
          <ul
            className="mt-2 max-h-56 overflow-y-auto rounded border border-slate-200"
            role="listbox"
            aria-label="ICD-11 matches"
          >
            {search.data.data.map((c) => (
              <li key={c.code}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50"
                  onClick={() => add.mutate(c.code)}
                  disabled={add.isPending}
                >
                  <span className="font-mono font-semibold">{c.code}</span> {c.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        {term.length >= 2 && search.data?.data.length === 0 && (
          <p className="mt-2 text-sm text-slate-600">No matching codes.</p>
        )}
        <ErrorMessage error={add.error || markError.error} />
      </Can>
    </section>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SERVICE_POINT_TYPES } from '@afyazuri/shared';
import { api } from '../api.js';
import { Can } from '../auth.jsx';
import { Badge, ErrorMessage, Spinner } from './ui.jsx';

const PAYER_LABEL = {
  null: 'Default (insured and others)',
  cash: 'Cash',
  sha: 'SHA',
  private_insurer: 'Private insurer',
  corporate: 'Corporate',
};
const MIDDLE = SERVICE_POINT_TYPES.filter((t) => t !== 'registration' && t !== 'exit');

/** View and edit the OPD route per payer type (always Registration → … → Exit). */
export default function OpdRoutes() {
  const q = useQuery({ queryKey: ['opd-routes'], queryFn: () => api.get('/opd-routes') });
  const [editing, setEditing] = useState(null); // { payerType, steps }
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (r) => api.put('/opd-routes', r),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['opd-routes'] });
    },
  });
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const routes = q.data.data;
  const missing = ['cash', 'sha', 'private_insurer'].filter((p) => !routes.some((r) => r.payerType === p));

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Where patients go after check-in, by how they pay. A payer type without its own route uses the default.
      </p>
      {routes.map((r) => (
        <div key={String(r.payerType)} className="card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="font-semibold">{PAYER_LABEL[r.payerType] ?? r.payerType}</h3>
            <Can perm="facilities.manage">
              <button
                className="btn-secondary min-h-8 px-3 text-xs"
                onClick={() => setEditing({ ...r, steps: [...r.steps] })}
              >
                Edit
              </button>
            </Can>
          </div>
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {r.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-1">
                <Badge tone={s === 'registration' || s === 'exit' ? 'slate' : 'teal'}>{s}</Badge>
                {i < r.steps.length - 1 && <span aria-hidden>→</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <Can perm="facilities.manage">
        {missing.length > 0 && !editing && (
          <div className="flex flex-wrap gap-2">
            {missing.map((p) => (
              <button
                key={p}
                className="btn-secondary"
                onClick={() => setEditing({ payerType: p, steps: ['registration', 'triage', 'consultation', 'exit'] })}
              >
                Add route for {PAYER_LABEL[p]}
              </button>
            ))}
          </div>
        )}
        {editing && (
          <form
            className="card space-y-3 border-brand-600 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(editing);
            }}
          >
            <h3 className="font-semibold">Route for {PAYER_LABEL[editing.payerType] ?? editing.payerType}</h3>
            <ol className="space-y-2">
              {editing.steps.map((s, i) => {
                const fixed = i === 0 || i === editing.steps.length - 1;
                return (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-6 text-right text-sm text-slate-600">{i + 1}.</span>
                    {fixed ? (
                      <Badge>{s}</Badge>
                    ) : (
                      <>
                        <select
                          aria-label={`Step ${i + 1}`}
                          className="input w-auto"
                          value={s}
                          onChange={(e) => {
                            const steps = [...editing.steps];
                            steps[i] = e.target.value;
                            setEditing({ ...editing, steps });
                          }}
                        >
                          {MIDDLE.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="text-sm text-red-700 hover:underline"
                          onClick={() => setEditing({ ...editing, steps: editing.steps.filter((_, j) => j !== i) })}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                const steps = [...editing.steps];
                steps.splice(steps.length - 1, 0, 'consultation');
                setEditing({ ...editing, steps });
              }}
            >
              Add step
            </button>
            <ErrorMessage error={save.error} />
            <div className="flex gap-2">
              <button className="btn-primary" disabled={save.isPending}>
                Save route
              </button>
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </Can>
    </div>
  );
}

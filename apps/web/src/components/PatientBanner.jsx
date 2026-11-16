import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Badge, ErrorMessage } from './ui.jsx';

const SEVERITY_TONE = { life_threatening: 'red', severe: 'red', moderate: 'amber', mild: 'slate' };

/**
 * Identity strip shown at the top of every clinical screen: name, age, sex, MRN,
 * payer and allergies. Restricted records offer break-the-glass to clinical roles.
 * @param {{patient: any}} props
 */
export default function PatientBanner({ patient: p }) {
  const primary = p.payerSchemes?.find((s) => s.isPrimary) ?? p.payerSchemes?.[0];
  return (
    <section aria-label="Patient" className="card mb-4 border-l-4 border-l-brand-700 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Link to={`/patients/${p.id}`} className="text-lg font-semibold text-slate-900 hover:underline">
          {p.fullName}
        </Link>
        <span className="text-sm text-slate-700">
          {p.age} · {p.sex}
          {p.dobEstimated && <span title="Estimated date of birth"> (est.)</span>}
        </span>
        <span className="font-mono text-sm text-slate-700">{p.mrn}</span>
        <Badge tone={primary ? 'blue' : 'slate'}>
          {primary ? `${primary.payerName} · ${primary.schemeName}` : 'Cash'}
        </Badge>
        {p.isRestricted && <Badge tone="amber">Restricted record</Badge>}
      </div>
      <div className="mt-2">
        <Allergies patient={p} />
      </div>
    </section>
  );
}

function Allergies({ patient: p }) {
  if (p.clinical?.reason === 'restricted') return <BreakGlass patientId={p.id} />;
  if (!p.clinical?.canView) return null;
  if (!p.allergies?.length) return <p className="text-sm text-slate-600">No known allergies recorded</p>;
  return (
    <div className="flex flex-wrap items-center gap-2" role="alert">
      <span className="text-sm font-semibold text-red-800">Allergies:</span>
      {p.allergies.map((a) => (
        <Badge key={a.id} tone={SEVERITY_TONE[a.severity]}>
          {a.allergen} ({a.severity.replace('_', '-')})
        </Badge>
      ))}
    </div>
  );
}

function BreakGlass({ patientId }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/patients/${patientId}/break-glass`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  });
  if (!can('emr.break_glass'))
    return (
      <p className="text-sm text-amber-900">
        Clinical details of this restricted record are not available to your role.
      </p>
    );
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
      <p>Clinical details are restricted. Emergency access is time-limited, logged and reviewed by your facility.</p>
      {!open ? (
        <button className="btn-secondary mt-2" onClick={() => setOpen(true)}>
          Request emergency access
        </button>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <label className="min-w-64 flex-1">
            <span className="label">Clinical reason</span>
            <input
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={10}
              required
            />
          </label>
          <button className="btn-danger" disabled={reason.trim().length < 10 || m.isPending}>
            Open record
          </button>
          <div className="w-full">
            <ErrorMessage error={m.error} />
          </div>
        </form>
      )}
    </div>
  );
}

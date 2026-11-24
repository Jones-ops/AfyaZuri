import { useQueries } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import Barcode from '../components/lab/Barcode.jsx';
import { ErrorMessage, PageSkeleton } from '../components/ui.jsx';

const time = (v) =>
  new Intl.DateTimeFormat('en-KE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Nairobi' }).format(
    new Date(v),
  );

/** Tube labels (50 × 25 mm), one per sample, with a Code 128 barcode of the accession. */
export default function LabLabels() {
  const [params] = useSearchParams();
  const ids = (params.get('ids') ?? '').split(',').filter(Boolean);
  const labels = useQueries({
    queries: ids.map((id) => ({ queryKey: ['label', id], queryFn: () => api.get(`/lab-samples/${id}/label`) })),
  });
  if (labels.some((l) => l.isPending)) return <PageSkeleton />;
  const err = labels.find((l) => l.error)?.error;
  if (err) return <ErrorMessage error={err} />;
  return (
    <div>
      <div className="no-print mb-4 flex gap-2">
        <button className="btn-primary" onClick={() => window.print()}>
          Print labels
        </button>
        <Link className="btn-secondary" to="/lab">
          Back to the lab
        </Link>
      </div>
      <div className="flex flex-wrap gap-3 print:block">
        {labels.map(({ data: l }) => (
          <article
            key={l.id}
            className="label-tube w-[50mm] overflow-hidden border border-slate-300 bg-white p-[1.5mm] font-mono text-[7pt] leading-tight text-black print:mb-[2mm] print:break-after-page print:border-0"
          >
            <div className="flex justify-between font-bold">
              <span className="truncate">{l.patient.name}</span>
              {l.priority !== 'routine' && <span>{l.priority.toUpperCase()}</span>}
            </div>
            <div className="flex justify-between">
              <span>{l.patient.mrn}</span>
              <span>
                {l.patient.sex === 'female' ? 'F' : l.patient.sex === 'male' ? 'M' : 'U'} {l.patient.age}
              </span>
            </div>
            <Barcode value={l.accession} height={28} />
            <div className="truncate">
              {l.tests.join(' ')} · {l.container}
            </div>
            <div>{time(l.collectedAt)}</div>
          </article>
        ))}
      </div>
    </div>
  );
}

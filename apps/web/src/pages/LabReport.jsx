import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { ResultTable } from '../components/lab/Results.jsx';
import { ErrorMessage, PageSkeleton } from '../components/ui.jsx';

const when = (v) =>
  v
    ? new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' }).format(
        new Date(v),
      )
    : '—';
const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

/** Printable lab result report on the facility letterhead (print to PDF from the browser). */
export default function LabReport() {
  const { id } = useParams();
  const r = useQuery({ queryKey: ['lab-report', id], queryFn: () => api.get(`/lab-orders/${id}/report`) });
  if (r.isPending) return <PageSkeleton />;
  if (r.error) return <ErrorMessage error={r.error} />;
  const d = r.data;
  return (
    <div>
      <div className="no-print mb-4">
        <button className="btn-primary" onClick={() => window.print()}>
          Print / save as PDF
        </button>
      </div>
      <article className="mx-auto max-w-[190mm] bg-white p-[10mm] text-[10pt] text-black shadow-sm print:p-0 print:shadow-none">
        <header className="mb-3 border-b-2 border-black pb-2 text-center">
          <p className="text-[14pt] font-bold">{d.facility.name}</p>
          <p>
            KMHFL {d.facility.kmhflCode}
            {d.facility.address && ` · ${d.facility.address}`}
            {d.facility.phone && ` · Tel ${d.facility.phone}`}
          </p>
          <p className="mt-1 font-bold tracking-wide">LABORATORY RESULT REPORT</p>
        </header>
        <section className="mb-3 grid grid-cols-2 gap-x-6 text-[9pt]">
          <p>
            <strong>Patient:</strong> {d.patient.name}
          </p>
          <p>
            <strong>MRN:</strong> {d.patient.mrn}
          </p>
          <p>
            <strong>Sex / DOB:</strong> {d.patient.sex} · {d.patient.dateOfBirth}
          </p>
          <p>
            <strong>Order:</strong> {d.orderNumber} ({d.priority})
          </p>
          <p>
            <strong>Requested by:</strong> {d.orderedBy}
          </p>
          <p>
            <strong>Requested:</strong> {when(d.orderedAt)}
          </p>
          {d.clinicalNotes && (
            <p className="col-span-2">
              <strong>Clinical notes:</strong> {d.clinicalNotes}
            </p>
          )}
        </section>
        {d.tests.length === 0 && <p>No results have been released for this order yet.</p>}
        {d.tests.map((t) => (
          <section key={t.itemId} className="mb-4 break-inside-avoid">
            <h2 className="border-b border-black text-[11pt] font-bold">
              {t.test.name} <span className="font-normal">({t.section})</span>
            </h2>
            <ResultTable data={t} />
            <p className="mt-1 text-[8pt]">
              Sample {t.accession} ({t.specimenType}) collected {when(t.collectedAt)}, received {when(t.receivedAt)}.
              Verified by {t.verifiedBy}, {when(t.verifiedAt)}. Turnaround {hm(t.turnaroundMinutes)}.
            </p>
          </section>
        ))}
        <footer className="mt-6 border-t border-black pt-1 text-[8pt]">
          Results relate only to the samples tested. Reference ranges are for the patient&apos;s sex and age. Printed{' '}
          {when(new Date())}.
        </footer>
      </article>
    </div>
  );
}

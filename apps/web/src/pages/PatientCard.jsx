import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { ErrorMessage, PageSkeleton } from '../components/ui.jsx';
import { usePatient } from './PatientDetail.jsx';

/**
 * Printable patient card (credit-card size, 85.6 × 54 mm). The QR code holds only
 * the MRN — no other personal data — so a lost card reveals nothing clinical.
 */
export default function PatientCard() {
  const { id } = useParams();
  const { me } = useAuth();
  const q = usePatient(id);
  const [qr, setQr] = useState(null);

  useEffect(() => {
    if (!q.data) return;
    import('qrcode')
      .then((QR) => QR.toDataURL(q.data.mrn, { margin: 0, width: 240, errorCorrectionLevel: 'M' }))
      .then(setQr);
  }, [q.data]);

  if (q.isPending) return <PageSkeleton />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const p = q.data;

  return (
    <div>
      <div className="no-print mb-4 flex gap-2">
        <button className="btn-primary" onClick={() => window.print()} disabled={!qr}>
          Print card
        </button>
        <Link to={`/patients/${p.id}`} className="btn-secondary">
          Back to record
        </Link>
      </div>
      <div className="patient-card mx-auto flex w-[85.6mm] max-w-full gap-3 rounded-lg border border-slate-400 bg-white p-[4mm] text-slate-900">
        <div className="min-w-0 flex-1">
          <p className="text-[8pt] font-semibold tracking-wide text-brand-800 uppercase">{me.facility?.name}</p>
          <p className="mt-1 truncate text-[11pt] font-bold">{p.fullName}</p>
          <p className="text-[8pt]">
            {p.sex} · DOB {p.dateOfBirth}
            {p.dobEstimated ? ' (est.)' : ''}
          </p>
          <p className="mt-2 text-[7pt] text-slate-600">MRN / Nambari ya mgonjwa</p>
          <p className="font-mono text-[12pt] font-bold">{p.mrn}</p>
          <p className="mt-1 text-[6.5pt] text-slate-600">
            Bring this card on every visit · Leta kadi hii kila unapokuja
          </p>
        </div>
        {qr ? (
          <img src={qr} alt={`QR code for MRN ${p.mrn}`} className="h-[24mm] w-[24mm] self-center" />
        ) : (
          <div className="h-[24mm] w-[24mm]" />
        )}
      </div>
    </div>
  );
}

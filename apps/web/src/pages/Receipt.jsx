import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { formatKES } from '@afyazuri/shared';
import { api } from '../api.js';
import { ErrorMessage, Spinner } from '../components/ui.jsx';

const METHOD = { cash: 'Cash / Pesa taslimu', mpesa: 'M-Pesa', card: 'Card / Kadi', bank: 'Bank / Benki' };
const when = (v) =>
  new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' }).format(
    new Date(v),
  );

/** Receipt for an 80 mm thermal printer, with English and Kiswahili labels. */
export default function Receipt() {
  const { id } = useParams();
  const r = useQuery({ queryKey: ['receipt', id], queryFn: () => api.get(`/receipts/${id}`) });
  const reprint = useMutation({
    mutationFn: () => api.post(`/receipts/${id}/reprint`),
    onSuccess: () => window.print(),
  });
  if (r.isPending) return <Spinner />;
  if (r.error) return <ErrorMessage error={r.error} />;
  const d = r.data;
  const Row = ({ label, value, strong }) => (
    <div className={`flex justify-between gap-2 ${strong ? 'font-bold' : ''}`}>
      <span>{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
  return (
    <div>
      <div className="no-print mb-4 flex gap-2">
        <button className="btn-primary" onClick={() => window.print()}>
          Print receipt
        </button>
        <button className="btn-secondary" onClick={() => reprint.mutate()}>
          Reprint (marked as copy)
        </button>
      </div>
      <article className="receipt mx-auto w-[80mm] max-w-full bg-white p-[3mm] font-mono text-[9pt] leading-snug text-black">
        <header className="text-center">
          <p className="text-[11pt] font-bold">{d.facility.name}</p>
          <p>KMHFL {d.facility.kmhflCode}</p>
          {d.facility.address && <p>{d.facility.address}</p>}
          {d.facility.phone && <p>Tel {d.facility.phone}</p>}
          <p className="mt-1 font-bold">OFFICIAL RECEIPT / STAKABADHI</p>
          {d.reprintCount > 0 && <p>** COPY / NAKALA #{d.reprintCount} **</p>}
        </header>
        <hr className="my-1 border-dashed border-black" />
        <Row label="Receipt / Stakabadhi" value={d.receiptNumber} />
        <Row label="Date / Tarehe" value={when(d.issuedAt)} />
        <Row label="Bill / Ankara" value={d.billNumber} />
        <Row label="Patient / Mgonjwa" value={d.patient.fullName} />
        {d.patient.mrn && <Row label="MRN" value={d.patient.mrn} />}
        {d.schemeName && <Row label="Scheme / Mpango" value={d.schemeName} />}
        <hr className="my-1 border-dashed border-black" />
        <Row label="Paid / Imelipwa" value={formatKES(d.payment.amount)} strong />
        <Row label="Method / Njia" value={METHOD[d.payment.method]} />
        {d.payment.reference && <Row label="Ref / Kumbukumbu" value={d.payment.reference} />}
        <hr className="my-1 border-dashed border-black" />
        <Row label="Bill total / Jumla" value={formatKES(d.bill.totalAmount)} />
        {Number(d.bill.payerAmount) > 0 && <Row label="Insurer pays / Bima" value={formatKES(d.bill.payerAmount)} />}
        <Row label="Paid to date / Umelipa" value={formatKES(d.bill.paidAmount)} />
        <Row label="Balance / Salio" value={formatKES(d.bill.balance)} strong />
        <hr className="my-1 border-dashed border-black" />
        <p>Served by / Umehudumiwa na: {d.cashierName}</p>
        <p>Medical services are VAT exempt. / Huduma za matibabu hazitozwi VAT.</p>
        {d.etims.invoiceNumber && <p>eTIMS: {d.etims.invoiceNumber}</p>}
        <p className="mt-1 text-center">Asante · Thank you · Pona haraka</p>
      </article>
    </div>
  );
}

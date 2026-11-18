import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatKES, sumAmounts, toCents } from '@afyazuri/shared';
import { api } from '../api.js';
import { Can } from '../auth.jsx';
import { AdjustmentsPanel } from '../components/billing/Adjustments.jsx';
import PaymentPanel from '../components/billing/PaymentPanel.jsx';
import { Badge, ErrorMessage, Field, PageHeader, formatDateTime, PageSkeleton } from '../components/ui.jsx';
import { BILL_STATUS_TONE } from './Bills.jsx';

export function useBill(id) {
  return useQuery({ queryKey: ['bill', id], queryFn: () => api.get(`/bills/${id}`), enabled: !!id });
}

/** One bill: totals, lines (with manual charges and voids) and payments. */
export default function BillDetail({ children }) {
  const { id } = useParams();
  const bill = useBill(id);
  if (bill.isPending) return <PageSkeleton />;
  if (bill.error) return <ErrorMessage error={bill.error} />;
  const b = bill.data;
  return (
    <>
      <PageHeader
        title={`Bill ${b.billNumber}`}
        description={
          <>
            {b.patient.id ? (
              <Link to={`/patients/${b.patient.id}`} className="text-brand-800 hover:underline">
                {b.patient.fullName}
              </Link>
            ) : (
              b.patient.fullName
            )}{' '}
            · <span className="font-mono">{b.patient.mrn}</span> ·{' '}
            {b.payer ? `${b.payer.payerName} — ${b.payer.schemeName} (${b.payer.memberNumber})` : 'Cash'} ·{' '}
            {b.billingMode === 'pay_first' ? 'pay before service' : 'bill at exit'}{' '}
            <Badge tone={BILL_STATUS_TONE[b.status]}>{b.status === 'closed' ? 'settled' : b.status}</Badge>
          </>
        }
      />
      <Totals bill={b} />
      <Can perm="billing.payment.receive">
        <PaymentPanel bill={b} />
      </Can>
      {children?.(b)}
      <Lines bill={b} />
      <Payments bill={b} />
      <AdjustmentsPanel bill={b} />
    </>
  );
}

function Totals({ bill: b }) {
  const cells = [
    ['Total charges', b.totalAmount],
    ['Payer covers', b.payerAmount],
    ['Patient share', b.patientAmount],
    ['Paid', b.paidAmount],
    ['Waived / credited', sumAmounts([b.waivedAmount, b.creditedAmount])],
  ];
  return (
    <section aria-label="Totals" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map(([label, v]) => (
        <div key={label} className="card p-3">
          <div className="text-xs text-slate-600">{label}</div>
          <div className="text-lg font-semibold">{formatKES(v, { currency: false })}</div>
        </div>
      ))}
      <div
        className={`card p-3 ${toCents(b.balance) > 0 ? 'border-amber-400 bg-amber-50' : toCents(b.balance) < 0 ? 'border-sky-400 bg-sky-50' : 'border-emerald-400 bg-emerald-50'}`}
      >
        <div className="text-xs text-slate-700">
          {toCents(b.balance) < 0 ? 'Overpaid (refund due)' : 'Patient owes'}
        </div>
        <div className="text-lg font-bold" data-testid="balance">
          {formatKES(b.balance)}
        </div>
      </div>
    </section>
  );
}

function Lines({ bill: b }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['bill', b.id] });
  const voidLine = useMutation({
    mutationFn: ({ id, reason }) => api.post(`/bill-items/${id}/void`, { reason }),
    onSuccess: refresh,
  });
  return (
    <section className="card mb-4 overflow-x-auto" aria-labelledby="lines-h">
      <h2 id="lines-h" className="px-4 pt-4 font-semibold">
        Charges
      </h2>
      <table className="table-base mt-2">
        <thead>
          <tr>
            <th>Item</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Price</th>
            <th className="text-right">Total</th>
            <th className="text-right">Payer</th>
            <th className="text-right">Patient</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {b.items.map((i) => (
            <tr key={i.id} className={i.status === 'voided' ? 'text-slate-400' : ''}>
              <td>
                <span className={i.status === 'voided' ? 'line-through' : ''}>{i.description}</span>
                <div className="text-xs text-slate-600">
                  <span className="font-mono">{i.code}</span> · {i.sourceType} · {formatDateTime(i.postedAt)}
                  {i.unpriced && (
                    <span className="ml-1">
                      <Badge tone="amber">no price set</Badge>
                    </span>
                  )}
                  {i.voidReason && <span className="ml-1">· voided: {i.voidReason}</span>}
                </div>
              </td>
              <td className="text-right">{i.quantity}</td>
              <td className="text-right whitespace-nowrap">{formatKES(i.unitPrice, { currency: false })}</td>
              <td className="text-right whitespace-nowrap">{formatKES(i.totalAmount, { currency: false })}</td>
              <td className="text-right whitespace-nowrap">{formatKES(i.payerAmount, { currency: false })}</td>
              <td className="text-right font-medium whitespace-nowrap">
                {formatKES(i.patientAmount, { currency: false })}
              </td>
              <td className="text-right">
                {i.status === 'active' && b.status !== 'cancelled' && (
                  <Can perm="billing.charge.manual">
                    <button
                      className="text-xs text-red-700 hover:underline"
                      onClick={() => {
                        const reason = window.prompt(`Why void "${i.description}"?`);
                        if (reason) voidLine.mutate({ id: i.id, reason });
                      }}
                    >
                      Void
                    </button>
                  </Can>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 pb-4">
        <ErrorMessage error={voidLine.error} />
        {b.status !== 'cancelled' && b.encounterId && (
          <Can perm="billing.charge.manual">
            <AddCharge billId={b.id} onDone={refresh} />
          </Can>
        )}
      </div>
    </section>
  );
}

function AddCharge({ billId, onDone }) {
  const items = useQuery({
    queryKey: ['charge-items', 'active'],
    queryFn: () => api.get('/charge-items?active=true'),
    staleTime: 60_000,
  });
  const [itemId, setItemId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const chosen = items.data?.data.find((i) => i.id === itemId);
  const needsPrice = chosen && chosen.cashPrice === null;
  const add = useMutation({
    mutationFn: () =>
      api.post(`/bills/${billId}/items`, {
        chargeItemId: itemId,
        quantity: Number(quantity),
        ...(needsPrice ? { unitPrice: price } : {}),
        ...(description ? { description } : {}),
      }),
    onSuccess: () => {
      setItemId('');
      setQuantity(1);
      setPrice('');
      setDescription('');
      onDone();
    },
  });
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-[2fr_auto_auto_2fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <Field label="Add a charge">
        <select className="input" value={itemId} onChange={(e) => setItemId(e.target.value)}>
          <option value="">Choose a service…</option>
          {items.data?.data.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} {i.cashPrice ? `(${formatKES(i.cashPrice)})` : '(price on entry)'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Qty">
        <input
          className="input w-20"
          type="number"
          min="1"
          step="1"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </Field>
      {needsPrice ? (
        <Field label="Price (KES)">
          <input className="input w-28" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
      ) : (
        <span />
      )}
      <Field label="Description (optional)">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <button className="btn-secondary" disabled={!itemId || (needsPrice && !price) || add.isPending}>
        Add
      </button>
      <div className="sm:col-span-5">
        <ErrorMessage error={add.error} />
      </div>
    </form>
  );
}

function Payments({ bill: b }) {
  if (!b.payments.length) return null;
  return (
    <section className="card mb-4 overflow-x-auto" aria-labelledby="pay-h">
      <h2 id="pay-h" className="px-4 pt-4 font-semibold">
        Payments
      </h2>
      <table className="table-base mt-2">
        <thead>
          <tr>
            <th>When</th>
            <th>Method</th>
            <th>Reference</th>
            <th>Receipt</th>
            <th className="text-right">Amount</th>
            <th>Status</th>
            <th>eTIMS</th>
            <th>SMS</th>
          </tr>
        </thead>
        <tbody>
          {b.payments.map((p) => (
            <tr key={p.id}>
              <td className="whitespace-nowrap">{formatDateTime(p.receivedAt)}</td>
              <td className="uppercase">{p.method}</td>
              <td className="font-mono">{p.reference ?? '—'}</td>
              <td className="font-mono">
                {p.receiptId ? (
                  <Link className="text-brand-800 hover:underline" to={`/billing/receipts/${p.receiptId}`}>
                    {p.receiptNumber}
                  </Link>
                ) : (
                  '—'
                )}
              </td>
              <td className="text-right whitespace-nowrap">{formatKES(p.amount)}</td>
              <td>
                <Badge tone={p.status === 'completed' ? 'green' : p.status === 'pending' ? 'amber' : 'red'}>
                  {p.status}
                </Badge>
              </td>
              <td>
                <EtimsCell receipt={p} />
              </td>
              <td className="text-xs text-slate-600">{SMS_LABEL[p.sms] ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const SMS_LABEL = {
  sent: 'Sent',
  queued: 'Sending…',
  failed: 'Failed',
  skipped_no_consent: 'No consent',
  skipped_no_phone: 'No phone',
  disabled: 'Off',
};

/** eTIMS status for a receipt, with a retry when the submission failed. */
function EtimsCell({ receipt: p }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.post(`/receipts/${p.receiptId}/etims-retry`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['bill'] }),
  });
  if (!p.receiptId || !p.etims?.status) return '—';
  if (p.etims.status === 'submitted')
    return (
      <span className="font-mono text-xs" title="KRA eTIMS control-unit invoice number">
        {p.etims.invoiceNumber}
      </span>
    );
  if (p.etims.status === 'not_required') return <span className="text-xs text-slate-600">not required</span>;
  return (
    <span className="flex items-center gap-2">
      <Badge tone={p.etims.status === 'failed' ? 'red' : 'slate'}>{p.etims.status}</Badge>
      {p.etims.status === 'failed' && (
        <Can perm={['billing.payment.receive', 'billing.invoice.create']}>
          <button
            className="text-xs text-brand-800 hover:underline"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Retry
          </button>
        </Can>
      )}
    </span>
  );
}

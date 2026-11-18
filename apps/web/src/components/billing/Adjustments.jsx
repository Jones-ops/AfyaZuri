import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatKES, fromCents, toCents } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Can, useAuth } from '../../auth.jsx';
import { Alert, Badge, ErrorMessage, Field, formatDateTime } from '../ui.jsx';

export const KIND_LABEL = { waiver: 'Waiver', credit_note: 'Credit note', refund: 'Refund' };
const STATUS_TONE = { requested: 'amber', approved: 'blue', rejected: 'red', paid: 'green' };
const APPROVE_PERM = {
  waiver: 'billing.waiver.approve',
  credit_note: 'billing.refund.approve',
  refund: 'billing.refund.approve',
};

/** Refresh every view that shows bills, approvals or the cashier's drawer. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all(['bill', 'approvals', 'shift', 'bills'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

/** Approve / reject, with an optional note. Hidden from the person who raised the request. */
export function DecisionButtons({ item }) {
  const { me, can } = useAuth();
  const refresh = useRefresh();
  const [note, setNote] = useState('');
  const path = item.kind === 'waiver' ? `/waivers/${item.id}/decision` : `/refunds/${item.id}/decision`;
  const m = useMutation({
    mutationFn: (approve) => api.post(path, { approve, note: note || null }),
    onSuccess: refresh,
  });
  if (item.status !== 'requested' || !can(APPROVE_PERM[item.kind])) return null;
  if (item.requestedById === me.user.id)
    return <p className="text-xs text-slate-600">Waiting for someone else to approve your request.</p>;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-64 min-h-9"
          aria-label={`Note on ${KIND_LABEL[item.kind].toLowerCase()} ${formatKES(item.amount)}`}
          placeholder="Note (optional)"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn-primary min-h-9" disabled={m.isPending} onClick={() => m.mutate(true)}>
          Approve
        </button>
        <button className="btn-secondary min-h-9" disabled={m.isPending} onClick={() => m.mutate(false)}>
          Reject
        </button>
      </div>
      <ErrorMessage error={m.error} />
    </div>
  );
}

/** Pay out an approved refund from the cashier's drawer (or by M-Pesa, card or bank with a reference). */
export function PayoutForm({ item }) {
  const refresh = useRefresh();
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const key = useRef(crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      api.post(`/refunds/${item.id}/pay`, { method, reference: reference || null }, { 'Idempotency-Key': key.current }),
    onSuccess: () => {
      key.current = crypto.randomUUID();
      refresh();
    },
  });
  if (item.kind !== 'refund' || item.status !== 'approved') return null;
  return (
    <Can perm="billing.payment.receive">
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Pay out by">
          <select className="input min-h-9" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="mpesa">M-Pesa</option>
            <option value="card">Card reversal</option>
            <option value="bank">Bank transfer</option>
          </select>
        </Field>
        {method !== 'cash' && (
          <Field label="Reference">
            <input className="input min-h-9" value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        )}
        <button className="btn-primary min-h-9" disabled={m.isPending || (method !== 'cash' && !reference)}>
          Pay out {formatKES(item.amount)}
        </button>
        <div className="basis-full">
          <ErrorMessage error={m.error} />
        </div>
      </form>
    </Can>
  );
}

/** One waiver / credit note / refund, with its trail and the actions this user may take. */
export function AdjustmentRow({ item, showBill = false }) {
  return (
    <li className="pop-in py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">
            {KIND_LABEL[item.kind]} {formatKES(item.amount)}
          </span>{' '}
          <Badge tone={STATUS_TONE[item.status]}>{item.status}</Badge>
          {item.documentNumber && <span className="ml-2 font-mono text-xs text-slate-600">{item.documentNumber}</span>}
          {item.kind === 'credit_note' && item.etims?.status && item.etims.status !== 'not_required' && (
            <span className="ml-2">
              <Badge
                tone={item.etims.status === 'submitted' ? 'green' : item.etims.status === 'failed' ? 'red' : 'slate'}
              >
                eTIMS {item.etims.status}
              </Badge>
            </span>
          )}
          {showBill && (
            <div className="text-sm">
              <Link className="text-brand-800 hover:underline" to={`/billing/bills/${item.bill.id}`}>
                {item.bill.billNumber}
              </Link>{' '}
              · {item.patient.fullName}{' '}
              {item.patient.mrn && <span className="font-mono text-xs">({item.patient.mrn})</span>}
            </div>
          )}
          <p className="text-sm text-slate-700">“{item.reason}”</p>
        </div>
        <div className="text-right text-xs text-slate-600">
          <div>
            Requested by {item.requestedBy}, {formatDateTime(item.requestedAt)}
          </div>
          {item.decidedBy && (
            <div>
              {item.status === 'rejected' ? 'Rejected' : 'Approved'} by {item.decidedBy}
              {item.decisionNote ? ` — ${item.decisionNote}` : ''}
            </div>
          )}
          {item.paidAt && (
            <div>
              Paid out {item.method && `by ${item.method}`} {formatDateTime(item.paidAt)}
              {item.reference ? ` · ${item.reference}` : ''}
            </div>
          )}
        </div>
      </div>
      <DecisionButtons item={item} />
      <PayoutForm item={item} />
    </li>
  );
}

/** Ask for a waiver, credit note or refund on this bill. */
function RequestForm({ bill }) {
  const { can } = useAuth();
  const refresh = useRefresh();
  const kinds = [
    can('billing.waiver.request') && ['waiver', 'Waiver'],
    can('billing.refund.request') && ['credit_note', 'Credit note'],
    can('billing.refund.request') && bill.payments.some((p) => p.status === 'completed') && ['refund', 'Refund'],
  ].filter(Boolean);
  const [kind, setKind] = useState(kinds[0]?.[0] ?? 'waiver');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [done, setDone] = useState(null);
  const key = useRef(crypto.randomUUID());
  const m = useMutation({
    mutationFn: () =>
      kind === 'waiver'
        ? api.post(`/bills/${bill.id}/waivers`, { amount, reason }, { 'Idempotency-Key': key.current })
        : api.post(
            `/bills/${bill.id}/refunds`,
            { kind, amount, reason, ...(kind === 'refund' ? { paymentId } : {}) },
            { 'Idempotency-Key': key.current },
          ),
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      setAmount('');
      setReason('');
      setDone(r);
      refresh();
    },
  });
  if (!kinds.length || bill.status === 'cancelled') return null;
  const hint = {
    waiver: `Forgive part of what the patient owes (up to ${formatKES(bill.balance)}).`,
    credit_note: 'Correct the bill downwards, e.g. a charge for a service not given. Reported to KRA eTIMS.',
    refund: 'Give money back from a payment. It can be paid out once the bill shows an overpayment.',
  }[kind];
  return (
    <form
      className="mt-3 border-t border-slate-200 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        setDone(null);
        m.mutate();
      }}
    >
      <div role="tablist" aria-label="Request type" className="mb-2 flex flex-wrap gap-1">
        {kinds.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={kind === k ? 'btn-primary min-h-8 px-3' : 'btn-secondary min-h-8 px-3'}
            onClick={() => setKind(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mb-2 text-xs text-slate-600">{hint}</p>
      <div className="grid gap-2 sm:grid-cols-[auto,1fr,2fr,auto] sm:items-end">
        {kind === 'refund' && (
          <Field label="From payment">
            <select className="input" value={paymentId} onChange={(e) => setPaymentId(e.target.value)} required>
              <option value="">Choose…</option>
              {bill.payments
                .filter((p) => p.status === 'completed')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.receiptNumber} · {p.method} {formatKES(p.amount)}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Amount (KES)">
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </Field>
        <Field label="Reason" hint="At least 10 characters; the approver sees this.">
          <input
            className="input"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </Field>
        <button className="btn-secondary" disabled={m.isPending || !amount || reason.trim().length < 10}>
          Request approval
        </button>
      </div>
      <div className="mt-2">
        <ErrorMessage error={m.error} />
        {done && (
          <Alert kind="success">
            {KIND_LABEL[done.kind]} of {formatKES(done.amount)} sent for approval.
          </Alert>
        )}
      </div>
    </form>
  );
}

/** Bill section: every waiver, credit note and refund, and the form to ask for one. */
export function AdjustmentsPanel({ bill }) {
  const items = [
    ...bill.waivers.map((w) => ({ ...w, kind: 'waiver' })),
    ...bill.refunds.map((f) => ({ ...f, kind: f.kind })),
  ].sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  const overpaid = toCents(bill.balance) < 0;
  return (
    <section className="card mb-4 p-4" aria-labelledby="adj-h">
      <h2 id="adj-h" className="font-semibold">
        Waivers, credit notes and refunds
      </h2>
      {overpaid && (
        <div className="mt-2">
          <Alert kind="info">
            The patient has overpaid by {formatKES(fromCents(-toCents(bill.balance)))}. Raise a refund to give it back.
          </Alert>
        </div>
      )}
      {items.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {items.map((i) => (
            <AdjustmentRow key={`${i.kind}-${i.id}`} item={i} />
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-slate-600">None on this bill.</p>
      )}
      <RequestForm bill={bill} />
    </section>
  );
}

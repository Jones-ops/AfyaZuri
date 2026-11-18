import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatKES, fromCents, toCents } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Alert, ErrorMessage, Field } from '../ui.jsx';

const METHODS = [
  ['cash', 'Cash'],
  ['mpesa', 'M-Pesa'],
  ['card', 'Card'],
  ['bank', 'Bank'],
];

/** Take a payment against a bill. Needs an open cashier shift. */
export default function PaymentPanel({ bill }) {
  const qc = useQueryClient();
  const shift = useQuery({ queryKey: ['shift'], queryFn: () => api.get('/shifts/current') });
  const [method, setMethod] = useState('cash');
  const [done, setDone] = useState(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['bill', bill.id] });
    qc.invalidateQueries({ queryKey: ['shift'] });
  };
  if (toCents(bill.balance) <= 0 && !done) return null;

  return (
    <section className="card mb-4 p-4" aria-labelledby="take-pay-h">
      <h2 id="take-pay-h" className="mb-3 font-semibold">
        Take payment
      </h2>
      {done && <PaidNotice result={done} />}
      {shift.data && !shift.data.shift ? (
        <Alert kind="warn">
          Open a cashier shift first.{' '}
          <Link className="underline" to="/cashier">
            Go to the cashier desk
          </Link>
        </Alert>
      ) : toCents(bill.balance) > 0 ? (
        <>
          <div role="tablist" aria-label="Payment method" className="mb-3 flex flex-wrap gap-1">
            {METHODS.map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={method === k}
                className={method === k ? 'btn-primary' : 'btn-secondary'}
                onClick={() => setMethod(k)}
              >
                {label}
              </button>
            ))}
          </div>
          {method === 'mpesa' ? (
            <MpesaForm
              bill={bill}
              onDone={(r) => {
                setDone(r);
                refresh();
              }}
            />
          ) : (
            <DeskForm
              bill={bill}
              method={method}
              onDone={(r) => {
                setDone(r);
                refresh();
              }}
            />
          )}
        </>
      ) : null}
    </section>
  );
}

function PaidNotice({ result }) {
  return (
    <div className="mb-3">
      <Alert kind="success">
        Paid {formatKES(result.payment?.amount ?? result.amount)}. Receipt{' '}
        <Link className="font-mono underline" to={`/billing/receipts/${result.receipt.id}`}>
          {result.receipt.receiptNumber}
        </Link>
        {result.changeDue && toCents(result.changeDue) > 0 && (
          <>
            {' '}
            · <strong>Change due {formatKES(result.changeDue)}</strong>
          </>
        )}
        {result.sentTo && (
          <>
            {' '}
            · patient sent to {result.sentTo.servicePointName} (ticket {result.sentTo.label})
          </>
        )}
      </Alert>
    </div>
  );
}

function DeskForm({ bill, method, onDone }) {
  const [amount, setAmount] = useState(bill.balance);
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const key = useRef(crypto.randomUUID());
  useEffect(() => setAmount(bill.balance), [bill.balance]);
  const m = useMutation({
    mutationFn: () =>
      api.post(
        `/bills/${bill.id}/payments`,
        {
          method,
          amount,
          ...(tendered ? { tendered } : {}),
          ...(reference ? { reference } : {}),
          clientId: key.current,
        },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      setTendered('');
      setReference('');
      onDone(r);
    },
  });
  let change = null;
  try {
    if (method === 'cash' && tendered) change = toCents(tendered.replace(/,/g, '')) - toCents(amount.replace(/,/g, ''));
  } catch {
    change = null;
  }
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Amount (KES)" hint={`Patient owes ${formatKES(bill.balance)}`}>
        <input
          className="input text-lg"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      {method === 'cash' ? (
        <Field
          label="Cash handed over"
          hint={change !== null && change >= 0 ? `Change: ${formatKES(fromCents(change))}` : undefined}
        >
          <input
            className="input text-lg"
            inputMode="decimal"
            value={tendered}
            onChange={(e) => setTendered(e.target.value)}
          />
        </Field>
      ) : (
        <Field label={method === 'card' ? 'Card authorisation code' : 'Bank slip / reference'}>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}
      <button className="btn-primary min-h-11" disabled={m.isPending || (method !== 'cash' && !reference)}>
        Receive {method}
      </button>
      <div className="sm:col-span-3">
        <ErrorMessage error={m.error} />
      </div>
    </form>
  );
}

function MpesaForm({ bill, onDone }) {
  const patient = useQuery({
    queryKey: ['patient', bill.patient.id],
    queryFn: () => api.get(`/patients/${bill.patient.id}`),
    enabled: !!bill.patient.id,
  });
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState(fromCents(Math.floor(toCents(bill.balance) / 100) * 100));
  const [txnId, setTxnId] = useState(null);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (patient.data?.phone && !phone) setPhone(patient.data.phone.replace('+254', '0'));
  }, [patient.data, phone]);
  const start = useMutation({
    mutationFn: () => api.post(`/bills/${bill.id}/mpesa`, { phone, amount }, { 'Idempotency-Key': key.current }),
    onSuccess: (t) => {
      key.current = crypto.randomUUID();
      setTxnId(t.id);
    },
  });
  const status = useQuery({
    queryKey: ['mpesa', txnId],
    queryFn: () => api.get(`/mpesa/${txnId}`),
    enabled: !!txnId,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 2000 : false),
  });
  const query = useMutation({ mutationFn: () => api.post(`/mpesa/${txnId}/query`), onSuccess: () => status.refetch() });
  const t = status.data;
  useEffect(() => {
    if (t?.status === 'completed' && t.receipt) {
      onDone({ amount: t.amount, receipt: t.receipt });
      setTxnId(null);
    }
  }, [t, onDone]);

  if (txnId && t?.status === 'pending')
    return (
      <div className="space-y-2" aria-live="polite">
        <Alert kind="info">
          Prompt sent to {phone}. Ask the patient to enter their M-Pesa PIN. Waiting for confirmation…
        </Alert>
        <button className="btn-secondary" onClick={() => query.mutate()} disabled={query.isPending}>
          Check status now
        </button>
      </div>
    );
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      {t && t.status !== 'completed' && (
        <div className="sm:col-span-3">
          <Alert kind="error">
            M-Pesa {t.status}: {t.resultDesc}. You can try again.
          </Alert>
        </div>
      )}
      <Field label="Phone number">
        <input className="input text-lg" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label="Amount (whole KES)">
        <input
          className="input text-lg"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <button className="btn-primary min-h-11" disabled={start.isPending || !phone}>
        Send M-Pesa prompt
      </button>
      <div className="sm:col-span-3">
        <ErrorMessage error={start.error} />
      </div>
    </form>
  );
}

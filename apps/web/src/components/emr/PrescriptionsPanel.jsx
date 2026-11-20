import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { FREQUENCIES, ROUTES, suggestQuantity } from '@afyazuri/shared';
import { api } from '../../api.js';
import { Can } from '../../auth.jsx';
import { ItemPicker } from '../inventory/common.jsx';
import { Alert, Badge, ErrorMessage, Field, formatDateTime } from '../ui.jsx';

const STATUS_TONE = { active: 'amber', partially_dispensed: 'blue', dispensed: 'green', cancelled: 'slate' };

const newLine = (item) => ({
  key: crypto.randomUUID(),
  item,
  doseValue: item.drug?.strengthValue ? String(item.drug.strengthValue) : '1',
  doseUnit: item.drug?.strengthUnit ?? item.baseUnit,
  route: ROUTES.includes(item.drug?.defaultRoute) ? item.drug.defaultRoute : 'oral',
  frequency: 'TDS',
  durationDays: '5',
  quantity: '',
  instructions: '',
});

/** Write a prescription: lines, a safety check, reasons for any warnings, then prescribe. */
function Prescribe({ encounterId, onDone }) {
  const [lines, setLines] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [reasons, setReasons] = useState({});
  const key = useRef(crypto.randomUUID());
  const set = (k, patch) => {
    setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
    setWarnings([]);
  };
  const body = () =>
    lines.map((l) => ({
      itemId: l.item.id,
      doseValue: Number(l.doseValue),
      doseUnit: l.doseUnit,
      route: l.route,
      frequency: l.frequency,
      durationDays: ['STAT', 'PRN'].includes(l.frequency) ? null : Number(l.durationDays) || null,
      quantity: l.quantity || null,
      instructions: l.instructions || null,
    }));
  const check = useMutation({
    mutationFn: () => api.post(`/encounters/${encounterId}/prescriptions/check`, { items: body() }),
    onSuccess: (r) => setWarnings(r.warnings),
  });
  const save = useMutation({
    mutationFn: () =>
      api.post(
        `/encounters/${encounterId}/prescriptions`,
        {
          items: body(),
          overrides: warnings
            .filter((w) => w.severity === 'warn')
            .map((w) => ({ itemId: w.itemId, code: w.code, reason: reasons[`${w.itemId}|${w.code}`] ?? '' })),
          clientId: key.current,
        },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: () => {
      key.current = crypto.randomUUID();
      setLines([]);
      setWarnings([]);
      setReasons({});
      onDone();
    },
    onError: (e) => e.details?.warnings && setWarnings(e.details.warnings),
  });
  const blocked = warnings.some((w) => w.severity === 'block');
  const needReason = warnings.filter((w) => w.severity === 'warn');
  const ready =
    lines.length > 0 &&
    !blocked &&
    needReason.every((w) => (reasons[`${w.itemId}|${w.code}`] ?? '').trim().length >= 5);
  const nameOf = (itemId) => lines.find((l) => l.item.id === itemId)?.item.name;

  return (
    <div className="space-y-3 border-t border-slate-100 pt-3">
      {lines.map((l) => {
        const suggested = suggestQuantity(
          {
            doseValue: Number(l.doseValue),
            doseUnit: l.doseUnit,
            frequency: l.frequency,
            durationDays: Number(l.durationDays),
          },
          l.item,
        );
        return (
          <fieldset key={l.key} className="pop-in rounded-lg border border-slate-200 bg-white/60 p-3">
            <legend className="px-1 text-sm font-semibold">
              {l.item.name} {l.item.drug?.keml && <Badge tone="teal">KEML</Badge>}
            </legend>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Field label="Dose">
                <input
                  className="input"
                  inputMode="decimal"
                  value={l.doseValue}
                  onChange={(e) => set(l.key, { doseValue: e.target.value })}
                />
              </Field>
              <Field label="Unit">
                <input
                  className="input"
                  value={l.doseUnit}
                  onChange={(e) => set(l.key, { doseUnit: e.target.value })}
                />
              </Field>
              <Field label="Route">
                <select className="input" value={l.route} onChange={(e) => set(l.key, { route: e.target.value })}>
                  {ROUTES.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
              <Field label="How often">
                <select
                  className="input"
                  value={l.frequency}
                  onChange={(e) => set(l.key, { frequency: e.target.value })}
                >
                  {Object.entries(FREQUENCIES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {k} — {v.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Days">
                <input
                  className="input"
                  inputMode="numeric"
                  disabled={['STAT', 'PRN'].includes(l.frequency)}
                  value={l.durationDays}
                  onChange={(e) => set(l.key, { durationDays: e.target.value })}
                />
              </Field>
              <Field label={`Supply (${l.item.baseUnit}s)`}>
                <input
                  className="input"
                  inputMode="decimal"
                  placeholder={suggested ? String(suggested) : 'required'}
                  value={l.quantity}
                  onChange={(e) => set(l.key, { quantity: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-56 flex-1">
                <Field label="Instructions to the patient">
                  <input
                    className="input"
                    value={l.instructions}
                    placeholder="e.g. after meals"
                    onChange={(e) => set(l.key, { instructions: e.target.value })}
                  />
                </Field>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              >
                Remove
              </button>
            </div>
          </fieldset>
        );
      })}
      <div className="max-w-md">
        <ItemPicker
          label="Add a drug"
          source="formulary"
          onPick={(item) => {
            if (!lines.some((l) => l.item.id === item.id)) setLines((ls) => [...ls, newLine(item)]);
            setWarnings([]);
          }}
        />
      </div>

      {warnings.length > 0 && (
        <div className="space-y-2" aria-live="polite">
          {warnings.map((w) => (
            <div
              key={`${w.itemId}|${w.code}|${w.message}`}
              className={`pop-in rounded-md border p-3 text-sm ${w.severity === 'block' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-950'}`}
              role="alert"
            >
              <strong>
                {w.severity === 'block' ? 'Blocked' : 'Warning'} · {nameOf(w.itemId)}:
              </strong>{' '}
              {w.message}
              {w.severity === 'warn' && (
                <input
                  className="input mt-2 bg-white"
                  aria-label={`Reason to go ahead: ${nameOf(w.itemId)} ${w.code}`}
                  placeholder="Reason to go ahead (required)"
                  value={reasons[`${w.itemId}|${w.code}`] ?? ''}
                  onChange={(e) => setReasons({ ...reasons, [`${w.itemId}|${w.code}`]: e.target.value })}
                />
              )}
            </div>
          ))}
          {blocked && <Alert>Remove the blocked drug and choose another.</Alert>}
        </div>
      )}
      <ErrorMessage error={check.error ?? (save.error?.code?.startsWith('RX_') ? null : save.error)} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={!lines.length || check.isPending}
          onClick={() => check.mutate()}
        >
          Check safety
        </button>
        <button type="button" className="btn-primary" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Prescribing…' : 'Prescribe'}
        </button>
      </div>
    </div>
  );
}

/** Prescriptions in this visit, and (for prescribers) writing a new one. */
export default function PrescriptionsPanel({ encounterId }) {
  const qc = useQueryClient();
  const [writing, setWriting] = useState(false);
  const list = useQuery({
    queryKey: ['prescriptions', encounterId],
    queryFn: () => api.get(`/encounters/${encounterId}/prescriptions`),
  });
  return (
    <section className="card p-4" aria-labelledby="rx-h">
      <div className="flex items-center justify-between">
        <h2 id="rx-h" className="font-semibold">
          Prescriptions
        </h2>
        <Can perm="orders.prescription.create">
          <button className="btn-secondary min-h-9" onClick={() => setWriting((v) => !v)}>
            {writing ? 'Close' : 'Prescribe'}
          </button>
        </Can>
      </div>
      <ErrorMessage error={list.error} />
      {(list.data?.data ?? []).map((rx) => (
        <div key={rx.id} className="mt-3 rounded-md border border-slate-200 p-3 text-sm">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-mono">{rx.rxNumber}</span>
            <Badge tone={STATUS_TONE[rx.status]}>{rx.status.replace('_', ' ')}</Badge>
            <span className="text-xs text-slate-600">
              {rx.prescriber}, {formatDateTime(rx.createdAt)}
            </span>
          </div>
          <ul className="space-y-0.5">
            {rx.items.map((i) => (
              <li key={i.id}>
                <span className="font-medium">{i.name}</span> — {i.dose} {i.route} {i.frequency}
                {i.durationDays ? ` × ${i.durationDays} d` : ''} · supply {i.quantity} ({i.dispensedQty} given)
                {i.warnings.length > 0 && (
                  <span className="ml-1 text-xs text-amber-800">
                    ⚠ {i.warnings.map((w) => w.code).join(', ')} acknowledged
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {list.data && list.data.data.length === 0 && !writing && (
        <p className="mt-2 text-sm text-slate-600">No prescriptions in this visit.</p>
      )}
      {writing && (
        <Prescribe
          encounterId={encounterId}
          onDone={() => {
            setWriting(false);
            qc.invalidateQueries({ queryKey: ['prescriptions', encounterId] });
          }}
        />
      )}
    </section>
  );
}

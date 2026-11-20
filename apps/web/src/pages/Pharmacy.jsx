import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, qs } from '../api.js';
import { Can } from '../auth.jsx';
import { ItemPicker, useStores } from '../components/inventory/common.jsx';
import OtcSales from '../components/pharmacy/OtcSales.jsx';
import {
  Alert,
  Badge,
  EmptyState,
  ErrorMessage,
  Field,
  PageHeader,
  Spinner,
  formatDateTime,
} from '../components/ui.jsx';

const SEVERITY_TONE = { mild: 'amber', moderate: 'amber', severe: 'red', life_threatening: 'red' };

function DispenseForm({ rx, storeId, onDone }) {
  const open = rx.items.filter((i) => ['pending', 'partially_dispensed'].includes(i.status));
  const [lines, setLines] = useState({});
  const key = useRef(crypto.randomUUID());
  const signature = `${rx.id}|${storeId}|${rx.items.map((i) => `${i.remaining}/${i.inStock}`).join()}`;
  useEffect(() => {
    setLines(
      Object.fromEntries(
        open.map((i) => [
          i.id,
          {
            give: true,
            quantity: String(Math.min(Number(i.remaining), Number(i.inStock ?? i.remaining))),
            sub: null,
            reason: '',
          },
        ]),
      ),
    );
    // Reset the form when the prescription, store or stock changes.
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (id, patch) => setLines((ls) => ({ ...ls, [id]: { ...ls[id], ...patch } }));
  const m = useMutation({
    mutationFn: () =>
      api.post(
        `/prescriptions/${rx.id}/dispense`,
        {
          storeId,
          lines: open
            .filter((i) => lines[i.id]?.give && Number(lines[i.id].quantity) > 0)
            .map((i) => ({
              prescriptionItemId: i.id,
              quantity: lines[i.id].quantity,
              substituteItemId: lines[i.id].sub?.id ?? null,
              substitutionReason: lines[i.id].sub ? lines[i.id].reason : null,
            })),
        },
        { 'Idempotency-Key': key.current },
      ),
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      onDone(r.dispensed);
    },
  });
  if (!open.length) return null;
  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Dispense</h3>
      {open.map((i) => {
        const l = lines[i.id] ?? {};
        const short = Number(i.inStock ?? 0) < Number(i.remaining);
        return (
          <div key={i.id} className="rounded-md border border-slate-200 bg-white/70 p-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!l.give}
                onChange={(e) => set(i.id, { give: e.target.checked })}
              />
              <span className="text-sm">
                <strong>{i.name}</strong> — {i.dose} {i.route} {i.frequency}
                {i.durationDays ? ` × ${i.durationDays} d` : ''}
                {i.instructions && <span className="block text-xs text-slate-600">“{i.instructions}”</span>}
                <span className="block text-xs text-slate-600">
                  To supply {i.remaining} {i.baseUnit}(s) · in stock here {i.inStock ?? '—'}
                  {short && <Badge tone="amber">short</Badge>}
                </span>
              </span>
            </label>
            {l.give && (
              <div className="mt-2 grid gap-2 sm:grid-cols-[8rem_1fr]">
                <Field label="Quantity now">
                  <input
                    className="input"
                    aria-label={`Quantity of ${i.name}`}
                    inputMode="decimal"
                    value={l.quantity ?? ''}
                    onChange={(e) => set(i.id, { quantity: e.target.value })}
                  />
                </Field>
                {l.sub ? (
                  <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                    <div className="text-sm">
                      Substitute: <strong>{l.sub.name}</strong>
                    </div>
                    <Field label="Why substitute?">
                      <input
                        className="input"
                        value={l.reason}
                        onChange={(e) => set(i.id, { reason: e.target.value })}
                      />
                    </Field>
                    <button
                      type="button"
                      className="btn-secondary min-h-10"
                      onClick={() => set(i.id, { sub: null, reason: '' })}
                    >
                      Undo
                    </button>
                  </div>
                ) : (
                  <ItemPicker
                    label="Substitute (optional)"
                    source="formulary"
                    onPick={(item) => set(i.id, { sub: item })}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      <ErrorMessage error={m.error} />
      {m.error?.details?.warnings?.map((w) => (
        <Alert key={w.message}>{w.message}</Alert>
      ))}
      <button className="btn-primary" disabled={m.isPending || !storeId} onClick={() => m.mutate()}>
        {m.isPending ? 'Dispensing…' : 'Dispense and bill'}
      </button>
    </div>
  );
}

function Detail({ id, storeId, onDispensed }) {
  const qc = useQueryClient();
  const rx = useQuery({
    queryKey: ['prescription', id, storeId],
    queryFn: () => api.get(`/prescriptions/${id}${qs({ storeId })}`),
  });
  if (rx.isPending) return <Spinner rows={3} />;
  if (rx.error) return <ErrorMessage error={rx.error} />;
  const r = rx.data;
  return (
    <div className="space-y-3 border-t border-slate-100 bg-slate-50/50 p-4">
      <div className="text-sm">
        <strong>{r.patient.name}</strong> · {r.patient.mrn} · {r.patient.sex}, {r.patient.age} · prescribed by{' '}
        {r.prescriber}, {formatDateTime(r.createdAt)}
      </div>
      <div className="flex flex-wrap gap-1" aria-label="Allergies">
        {r.allergies.length === 0 ? (
          <Badge tone="green">No known allergies</Badge>
        ) : (
          r.allergies.map((a) => (
            <Badge key={a.allergen} tone={SEVERITY_TONE[a.severity]}>
              Allergy: {a.allergen} ({a.severity.replace('_', '-')})
            </Badge>
          ))
        )}
      </div>
      {r.items.some((i) => i.warnings.length) && (
        <Alert kind="warn">
          Prescriber overrode:{' '}
          {r.items.flatMap((i) => i.warnings.map((w) => `${i.name}: ${w.message} — “${w.overrideReason}”`)).join(' · ')}
        </Alert>
      )}
      <Can perm="pharmacy.dispense">
        <DispenseForm
          rx={r}
          storeId={storeId}
          onDone={(given) => {
            onDispensed({ rxNumber: r.rxNumber, patient: r.patient.name, given });
            qc.invalidateQueries({ queryKey: ['prescription', id] });
            qc.invalidateQueries({ queryKey: ['worklist'] });
          }}
        />
      </Can>
      {r.dispensations.length > 0 && (
        <div className="text-xs text-slate-700">
          Given:{' '}
          {r.dispensations
            .map(
              (d) =>
                `${d.item} × ${d.quantity} by ${d.by} (${formatDateTime(d.at)})${d.substitutionReason ? ` — substituted: ${d.substitutionReason}` : ''}`,
            )
            .join('; ')}
        </div>
      )}
    </div>
  );
}

/** Pharmacy worklist: prescriptions waiting to be dispensed, oldest first. */
export default function Pharmacy() {
  const stores = useStores();
  const dispensing = (stores.data?.data ?? []).filter((s) => s.dispensing && s.active);
  const [storeId, setStoreId] = useState('');
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [done, setDone] = useState(null);
  const [mode, setMode] = useState('rx');
  useEffect(() => {
    if (!storeId && dispensing.length) setStoreId(dispensing[0].id);
  }, [storeId, dispensing]);
  const list = useQuery({
    queryKey: ['worklist', tab, q],
    queryFn: () => api.get(`/pharmacy/worklist${qs({ status: tab, q: q || undefined })}`),
    refetchInterval: tab === 'open' ? 20_000 : false,
  });
  return (
    <>
      <PageHeader
        title="Pharmacy"
        description="Prescriptions to dispense and walk-in sales. Earliest-expiry stock is given first."
      />
      <div role="tablist" aria-label="Pharmacy work" className="mb-4 flex gap-1 border-b border-slate-200 pb-2">
        {[
          ['rx', 'Prescriptions'],
          ['otc', 'Walk-in sales'],
        ].map(([t, l]) => (
          <button
            key={t}
            role="tab"
            aria-selected={mode === t}
            aria-current={mode === t ? 'page' : undefined}
            className={`nav-item rounded-md px-3 py-1.5 text-sm font-medium ${mode === t ? 'text-brand-800' : 'text-slate-700 hover:bg-white'}`}
            onClick={() => setMode(t)}
          >
            {l}
          </button>
        ))}
      </div>
      <div
        className={`card mb-4 grid gap-3 p-4 sm:items-end ${mode === 'rx' ? 'sm:grid-cols-[1fr_2fr_auto]' : 'sm:grid-cols-[1fr_2fr]'}`}
      >
        <Field label="Dispensing from">
          <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {dispensing.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {mode === 'rx' && (
          <>
            <Field label="Find">
              <input
                className="input"
                placeholder="Name, MRN or RX number"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </Field>
            <div role="tablist" aria-label="Show" className="flex gap-1">
              {[
                ['open', 'Waiting'],
                ['dispensed', 'Dispensed'],
              ].map(([t, l]) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  className={tab === t ? 'btn-primary min-h-10' : 'btn-secondary min-h-10'}
                  onClick={() => setTab(t)}
                >
                  {l}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {mode === 'otc' ? (
        <OtcSales storeId={storeId} />
      ) : (
        <>
          {done && (
            <div className="mb-4">
              <Alert kind="success">
                Dispensed for {done.patient} ({done.rxNumber}):{' '}
                {done.given
                  .map(
                    (d) =>
                      `${d.item} × ${d.quantity} (batch ${d.batches.map((b) => `${b.batchNumber} exp ${b.expiryDate}`).join(', ')})`,
                  )
                  .join('; ')}
                {done.given.some((d) => d.billed) && '. Added to the patient’s bill.'}
              </Alert>
            </div>
          )}
          <section className="card" aria-label="Worklist">
            {list.isPending ? (
              <Spinner label="Loading prescriptions…" />
            ) : list.error ? (
              <ErrorMessage error={list.error} />
            ) : list.data.data.length === 0 ? (
              <EmptyState title={tab === 'open' ? 'Nothing waiting' : 'Nothing dispensed yet'} />
            ) : (
              <ul className="divide-y divide-slate-100">
                {list.data.data.map((r) => (
                  <li key={r.id}>
                    <button
                      className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-brand-50/40"
                      aria-expanded={open === r.id}
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                    >
                      <span className="font-mono text-sm">{r.rxNumber}</span>
                      <span className="font-medium">{r.patient}</span>
                      <span className="font-mono text-xs text-slate-600">{r.mrn}</span>
                      <Badge tone={r.status === 'active' ? 'amber' : r.status === 'dispensed' ? 'green' : 'blue'}>
                        {r.status.replace('_', ' ')}
                      </Badge>
                      <span className="ml-auto text-xs text-slate-600">
                        {r.items} item{r.items === 1 ? '' : 's'} · {r.prescriber} · {formatDateTime(r.createdAt)}
                      </span>
                    </button>
                    {open === r.id && <Detail id={r.id} storeId={storeId} onDispensed={setDone} />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

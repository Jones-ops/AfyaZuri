import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CHARGE_CATEGORIES, formatKES } from '@afyazuri/shared';
import { api } from '../api.js';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner } from '../components/ui.jsx';

const COVER_LABEL = {
  none: 'Patient pays',
  full: 'Payer pays all',
  fixed: 'Payer pays fixed KES',
  percent: 'Payer pays %',
};

/** Service catalogue and price lists (cash and per scheme, with payer cover rules). */
export default function BillingSetup() {
  const [tab, setTab] = useState('services');
  return (
    <>
      <PageHeader title="Billing setup" description="What the facility charges for, and what each payer covers." />
      <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-200">
        {[
          ['services', 'Services'],
          ['prices', 'Price lists'],
        ].map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`min-h-10 border-b-2 px-4 text-sm font-medium ${tab === k ? 'border-brand-700 text-brand-800' : 'border-transparent text-slate-600'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'services' ? <Services /> : <PriceLists />}
    </>
  );
}

function Services() {
  const qc = useQueryClient();
  const items = useQuery({ queryKey: ['charge-items', 'all'], queryFn: () => api.get('/charge-items') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments'), retry: false });
  const blank = { code: '', name: '', category: 'procedure', unit: 'each', departmentId: '' };
  const [f, setF] = useState(blank);
  const refresh = () => qc.invalidateQueries({ queryKey: ['charge-items'] });
  const create = useMutation({
    mutationFn: () => api.post('/charge-items', { ...f, departmentId: f.departmentId || null }),
    onSuccess: () => {
      setF(blank);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (i) => api.patch(`/charge-items/${i.id}`, { active: !i.active }),
    onSuccess: refresh,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <form
        className="card grid gap-3 p-4 sm:grid-cols-[1fr,2fr,1fr,1fr,1fr,auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Code">
          <input className="input uppercase" value={f.code} onChange={set('code')} />
        </Field>
        <Field label="Name">
          <input className="input" value={f.name} onChange={set('name')} />
        </Field>
        <Field label="Category">
          <select className="input" value={f.category} onChange={set('category')}>
            {CHARGE_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Unit">
          <input className="input" value={f.unit} onChange={set('unit')} />
        </Field>
        <Field label="Department">
          <select className="input" value={f.departmentId} onChange={set('departmentId')}>
            <option value="">—</option>
            {depts.data?.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn-primary" disabled={!f.code || f.name.length < 2 || create.isPending}>
          Add service
        </button>
        <div className="sm:col-span-6">
          <ErrorMessage error={create.error} />
        </div>
      </form>
      <div className="card overflow-x-auto">
        {items.isPending ? (
          <Spinner />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Code</th>
                <th>Service</th>
                <th>Category</th>
                <th className="text-right">Cash price</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.data?.data.map((i) => (
                <tr key={i.id}>
                  <td className="font-mono">{i.code}</td>
                  <td>
                    {i.name} <span className="text-xs text-slate-600">per {i.unit}</span>
                  </td>
                  <td>{i.category}</td>
                  <td className="text-right">
                    {i.cashPrice ? formatKES(i.cashPrice) : <Badge tone="amber">not priced</Badge>}
                  </td>
                  <td>{i.active ? <Badge tone="green">active</Badge> : <Badge>inactive</Badge>}</td>
                  <td className="text-right">
                    <button className="text-xs text-brand-800 hover:underline" onClick={() => toggle.mutate(i)}>
                      {i.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PriceLists() {
  const lists = useQuery({ queryKey: ['price-lists'], queryFn: () => api.get('/price-lists') });
  const [selected, setSelected] = useState(null);
  if (lists.isPending) return <Spinner />;
  if (lists.error) return <ErrorMessage error={lists.error} />;
  const current = lists.data.data.find((l) => l.id === selected) ?? lists.data.data[0];
  if (!current) return <EmptyState title="No price lists yet" />;
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem,1fr]">
      <ul className="card divide-y divide-slate-100" aria-label="Price lists">
        {lists.data.data.map((l) => (
          <li key={l.id}>
            <button
              className={`w-full px-3 py-2 text-left text-sm ${l.id === current.id ? 'bg-brand-50 font-semibold text-brand-800' : 'hover:bg-slate-50'}`}
              onClick={() => setSelected(l.id)}
            >
              {l.name}
              <div className="text-xs text-slate-600">
                {l.isDefault ? 'Cash (default)' : l.payerName} · {l.itemCount} prices
              </div>
            </button>
          </li>
        ))}
      </ul>
      <PriceListItems list={current} />
    </div>
  );
}

function PriceListItems({ list }) {
  const qc = useQueryClient();
  const items = useQuery({
    queryKey: ['price-list-items', list.id],
    queryFn: () => api.get(`/price-lists/${list.id}/items`),
  });
  const catalogue = useQuery({
    queryKey: ['charge-items', 'active'],
    queryFn: () => api.get('/charge-items?active=true'),
  });
  const [f, setF] = useState({ chargeItemId: '', unitPrice: '', coverType: 'none', coverValue: '0' });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['price-list-items', list.id] });
    qc.invalidateQueries({ queryKey: ['price-lists'] });
    qc.invalidateQueries({ queryKey: ['charge-items'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api.put(`/price-lists/${list.id}/items`, list.isDefault ? { ...f, coverType: 'none', coverValue: '0' } : f),
    onSuccess: () => {
      setF({ chargeItemId: '', unitPrice: '', coverType: 'none', coverValue: '0' });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (itemId) => api.delete(`/price-lists/${list.id}/items/${itemId}`),
    onSuccess: refresh,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <section className="card p-4" aria-label={list.name}>
      <h2 className="font-semibold">{list.name}</h2>
      <p className="mb-3 text-sm text-slate-600">
        {list.isDefault
          ? 'What cash patients pay, and the fallback for anything a scheme does not list.'
          : `Tariff for ${list.payerName} — ${list.schemeName}. The cover rule decides how much the payer pays; the patient pays the rest.`}
      </p>
      {items.isPending ? (
        <Spinner />
      ) : (
        <table className="table-base mb-4">
          <thead>
            <tr>
              <th>Service</th>
              <th className="text-right">Price</th>
              {!list.isDefault && <th>Cover</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {items.data?.data.map((i) => (
              <tr key={i.id}>
                <td>
                  {i.name} <span className="font-mono text-xs text-slate-600">{i.code}</span>
                </td>
                <td className="text-right">{formatKES(i.unitPrice)}</td>
                {!list.isDefault && (
                  <td>
                    {COVER_LABEL[i.coverType]}
                    {i.coverType === 'fixed' && ` ${formatKES(i.coverValue, { currency: false })}`}
                    {i.coverType === 'percent' && ` ${Number(i.coverValue)}%`}
                  </td>
                )}
                <td className="text-right">
                  <button className="text-xs text-red-700 hover:underline" onClick={() => remove.mutate(i.id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="grid gap-2 sm:grid-cols-[2fr,1fr,1.5fr,1fr,auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Service">
          <select className="input" value={f.chargeItemId} onChange={set('chargeItemId')}>
            <option value="">Choose…</option>
            {catalogue.data?.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Price (KES)">
          <input className="input" inputMode="decimal" value={f.unitPrice} onChange={set('unitPrice')} />
        </Field>
        {!list.isDefault ? (
          <>
            <Field label="Cover">
              <select className="input" value={f.coverType} onChange={set('coverType')}>
                {Object.entries(COVER_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={f.coverType === 'percent' ? 'Percent' : 'Amount per unit'}>
              <input
                className="input"
                inputMode="decimal"
                value={f.coverValue}
                onChange={set('coverValue')}
                disabled={f.coverType === 'none' || f.coverType === 'full'}
              />
            </Field>
          </>
        ) : (
          <>
            <span />
            <span />
          </>
        )}
        <button className="btn-primary" disabled={!f.chargeItemId || f.unitPrice === '' || save.isPending}>
          Save price
        </button>
        <div className="sm:col-span-5">
          <ErrorMessage error={save.error || remove.error} />
        </div>
      </form>
    </section>
  );
}

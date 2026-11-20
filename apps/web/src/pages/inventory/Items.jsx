import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DRUG_FORMS, INVENTORY_CATEGORIES } from '@afyazuri/shared';
import { api, qs } from '../../api.js';
import { Can } from '../../auth.jsx';
import { InventoryNav } from '../../components/inventory/common.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner } from '../../components/ui.jsx';

const EMPTY = {
  code: '',
  name: '',
  category: 'drug',
  baseUnit: 'tablet',
  chargeItemId: '',
  genericName: '',
  form: 'tablet',
  strength: '',
  keml: true,
  otcAllowed: false,
  atcCode: '',
  packName: '',
  packQty: '',
};

function NewItem({ onDone }) {
  const [v, setV] = useState(EMPTY);
  const charges = useQuery({ queryKey: ['charge-items', 'all'], queryFn: () => api.get('/charge-items?active=true') });
  const m = useMutation({
    mutationFn: () =>
      api.post('/items', {
        code: v.code,
        name: v.name,
        category: v.category,
        baseUnit: v.baseUnit,
        chargeItemId: v.chargeItemId || null,
        drug:
          v.category === 'drug'
            ? {
                genericName: v.genericName,
                form: v.form,
                strength: v.strength || null,
                keml: v.keml,
                otcAllowed: v.otcAllowed,
                atcCode: v.atcCode || null,
              }
            : null,
        packSizes: v.packName && v.packQty ? [{ name: v.packName, baseQty: v.packQty }] : [],
      }),
    onSuccess: (item) => {
      setV(EMPTY);
      onDone(item);
    },
  });
  const issues = Object.fromEntries((m.error?.details?.issues ?? []).map((i) => [i.path, i.message]));
  const f = (k) => ({ value: v[k], onChange: (e) => setV({ ...v, [k]: e.target.value }) });
  return (
    <form
      className="card mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <h2 className="font-semibold sm:col-span-2 lg:col-span-4">New item</h2>
      <Field label="Code" error={issues.code}>
        <input className="input uppercase" {...f('code')} required />
      </Field>
      <Field label="Name" error={issues.name}>
        <input className="input" {...f('name')} required />
      </Field>
      <Field label="Category">
        <select className="input" {...f('category')}>
          {INVENTORY_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Counted in (base unit)" hint="tablet, ml, vial, piece…">
        <input className="input" {...f('baseUnit')} required />
      </Field>
      {v.category === 'drug' && (
        <>
          <Field label="Generic name" error={issues['drug.genericName']}>
            <input className="input" {...f('genericName')} required />
          </Field>
          <Field label="Form">
            <select className="input" {...f('form')}>
              {DRUG_FORMS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field label="Strength" hint="e.g. 500 mg">
            <input className="input" {...f('strength')} />
          </Field>
          <Field label="ATC code" error={issues['drug.atcCode']}>
            <input className="input uppercase" {...f('atcCode')} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={v.keml} onChange={(e) => setV({ ...v, keml: e.target.checked })} />
            On the Kenya Essential Medicines List
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={v.otcAllowed}
              onChange={(e) => setV({ ...v, otcAllowed: e.target.checked })}
            />
            May be sold over the counter
          </label>
        </>
      )}
      <Field label="Pack name (optional)" hint="e.g. Box of 100">
        <input className="input" {...f('packName')} />
      </Field>
      <Field label="Units per pack">
        <input className="input" inputMode="decimal" {...f('packQty')} />
      </Field>
      <Field label="Billed as" hint="The price comes from the price list">
        <select className="input" {...f('chargeItemId')}>
          <option value="">Not sold to patients</option>
          {(charges.data?.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2 lg:col-span-4">
        <ErrorMessage error={m.error} />
        <button className="btn-primary mt-2" disabled={m.isPending}>
          Add item
        </button>
      </div>
    </form>
  );
}

/** Item master: drugs, consumables and reagents with their units and pack sizes. */
export default function Items() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['items', 'list', q, category],
    queryFn: () => api.get(`/items${qs({ q, category, limit: 200 })}`),
  });
  const toggle = useMutation({
    mutationFn: (i) => api.patch(`/items/${i.id}`, { active: !i.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['items'] }),
  });
  return (
    <>
      <PageHeader
        title="Items"
        description="The item master: what can be stocked, how it is counted and how it is billed."
        actions={
          <Can perm="inventory.items.manage">
            <button className="btn-primary" onClick={() => setCreating((x) => !x)}>
              {creating ? 'Close' : 'New item'}
            </button>
          </Can>
        }
      />
      <InventoryNav />
      {creating && (
        <NewItem
          onDone={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['items'] });
          }}
        />
      )}
      <div className="card mb-4 grid gap-3 p-4 sm:grid-cols-[2fr_1fr]">
        <Field label="Search">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, generic or code"
          />
        </Field>
        <Field label="Category">
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {INVENTORY_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>
      <section className="card overflow-x-auto" aria-label="Items">
        {list.isPending ? (
          <Spinner />
        ) : list.error ? (
          <ErrorMessage error={list.error} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No items match" />
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Unit</th>
                <th>Packs</th>
                <th className="text-right">Avg cost</th>
                <th>Billed as</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((i) => (
                <tr key={i.id} className={i.active ? '' : 'text-slate-400'}>
                  <td>
                    <span className="font-medium">{i.name}</span> {i.drug?.keml && <Badge tone="teal">KEML</Badge>}{' '}
                    {i.drug?.otcAllowed && <Badge tone="blue">OTC</Badge>}
                    <div className="text-xs text-slate-600">
                      <span className="font-mono">{i.code}</span>
                      {i.drug && ` · ${i.drug.genericName} · ${i.drug.form}`}
                      {i.drug?.atcCode && ` · ATC ${i.drug.atcCode}`}
                    </div>
                  </td>
                  <td>{i.category}</td>
                  <td>{i.baseUnit}</td>
                  <td className="text-xs">{i.packSizes.map((p) => `${p.name} (${p.baseQty})`).join(', ') || '—'}</td>
                  <td className="text-right tabular-nums">{i.averageCost}</td>
                  <td className="text-xs">{i.chargeItemName ?? '—'}</td>
                  <td>
                    <Can perm="inventory.items.manage">
                      <button className="text-xs text-brand-800 hover:underline" onClick={() => toggle.mutate(i)}>
                        {i.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

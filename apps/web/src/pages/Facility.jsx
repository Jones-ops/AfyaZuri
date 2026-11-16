import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { BED_STATUS, DEPARTMENT_TYPES, SERVICE_POINT_TYPES } from '@afyazuri/shared';
import { api } from '../api.js';
import { Can, useAuth } from '../auth.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner } from '../components/ui.jsx';

const TABS = [['departments', 'Departments'], ['servicePoints', 'Service points'], ['wards', 'Wards & beds']];

export default function Facility() {
  const [tab, setTab] = useState('departments');
  const { me } = useAuth();
  return (
    <>
      <PageHeader title="Facility setup" description={me.facility.name} />
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`min-h-10 border-b-2 px-4 text-sm font-medium whitespace-nowrap ${tab === k ? 'border-brand-700 text-brand-800' : 'border-transparent text-slate-600 hover:text-slate-900'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'departments' && <Departments />}
      {tab === 'servicePoints' && <ServicePoints />}
      {tab === 'wards' && <Wards />}
    </>
  );
}

/** Shared create form + mutation wiring for a facility resource. */
function useCreate(path, keys) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body) => api.post(path, body), onSuccess: () => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] })) });
}

function Departments() {
  const q = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments') });
  const create = useCreate('/departments', ['departments']);
  const form = useForm({ defaultValues: { type: 'opd' } });
  return (
    <div className="space-y-4">
      <Can perm="facilities.manage">
        <form className="card grid gap-3 p-4 sm:grid-cols-[2fr,1fr,1fr,auto] sm:items-end" onSubmit={form.handleSubmit((v) => create.mutate(v, { onSuccess: () => form.reset({ type: 'opd' }) }))}>
          <Field label="Name"><input className="input" {...form.register('name', { required: true })} /></Field>
          <Field label="Code"><input className="input uppercase" {...form.register('code', { required: true })} /></Field>
          <Field label="Type"><select className="input" {...form.register('type')}>{DEPARTMENT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <button className="btn-primary" disabled={create.isPending}>Add</button>
          <div className="sm:col-span-4"><ErrorMessage error={create.error} /></div>
        </form>
      </Can>
      <List q={q} cols={['Name', 'Code', 'Type', 'Status']} row={(d) => [d.name, d.code, d.type, d.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>]} />
    </div>
  );
}

function ServicePoints() {
  const q = useQuery({ queryKey: ['servicePoints'], queryFn: () => api.get('/service-points') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments') });
  const create = useCreate('/service-points', ['servicePoints']);
  const form = useForm({ defaultValues: { type: 'consultation' } });
  return (
    <div className="space-y-4">
      <Can perm="facilities.manage">
        <form className="card grid gap-3 p-4 sm:grid-cols-[2fr,1fr,1fr,auto] sm:items-end" onSubmit={form.handleSubmit((v) => create.mutate(v, { onSuccess: () => form.reset({ type: 'consultation' }) }))}>
          <Field label="Name"><input className="input" {...form.register('name', { required: true })} /></Field>
          <Field label="Department"><select className="input" {...form.register('departmentId', { required: true })}>{depts.data?.data.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Type"><select className="input" {...form.register('type')}>{SERVICE_POINT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <button className="btn-primary" disabled={create.isPending}>Add</button>
          <div className="sm:col-span-4"><ErrorMessage error={create.error} /></div>
        </form>
      </Can>
      <List q={q} cols={['Name', 'Department', 'Type']} row={(s) => [s.name, s.departmentName, s.type]} />
    </div>
  );
}

const BED_TONE = { available: 'green', occupied: 'red', reserved: 'blue', cleaning: 'amber', out_of_service: 'slate' };

function Wards() {
  const [wardId, setWardId] = useState(null);
  const q = useQuery({ queryKey: ['wards'], queryFn: () => api.get('/wards') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments') });
  const create = useCreate('/wards', ['wards']);
  const form = useForm({ defaultValues: { gender: 'mixed' } });
  return (
    <div className="space-y-4">
      <Can perm="facilities.manage">
        <form className="card grid gap-3 p-4 sm:grid-cols-[2fr,1fr,1fr,1fr,auto] sm:items-end" onSubmit={form.handleSubmit((v) => create.mutate(v, { onSuccess: () => form.reset({ gender: 'mixed' }) }))}>
          <Field label="Ward name"><input className="input" {...form.register('name', { required: true })} /></Field>
          <Field label="Code"><input className="input uppercase" {...form.register('code', { required: true })} /></Field>
          <Field label="Department"><select className="input" {...form.register('departmentId', { required: true })}>{depts.data?.data.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Gender"><select className="input" {...form.register('gender')}><option>mixed</option><option>male</option><option>female</option></select></Field>
          <button className="btn-primary" disabled={create.isPending}>Add</button>
          <div className="sm:col-span-5"><ErrorMessage error={create.error} /></div>
        </form>
      </Can>
      <List q={q} cols={['Ward', 'Department', 'Beds', 'Available', 'Occupied', '']}
        row={(w) => [w.name, w.departmentName, w.bedCount, w.available, w.occupied,
          <button key="b" className="text-sm text-brand-800 hover:underline" onClick={() => setWardId(w.id)}>Beds</button>]} />
      {wardId && <Beds wardId={wardId} />}
    </div>
  );
}

function Beds({ wardId }) {
  const qc = useQueryClient();
  const { canAny } = useAuth();
  const q = useQuery({ queryKey: ['beds', wardId], queryFn: () => api.get(`/wards/${wardId}/beds`) });
  const [label, setLabel] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['beds', wardId] }); qc.invalidateQueries({ queryKey: ['wards'] }); };
  const add = useMutation({ mutationFn: () => api.post(`/wards/${wardId}/beds`, { label }), onSuccess: () => { setLabel(''); refresh(); } });
  const status = useMutation({ mutationFn: ({ id, s }) => api.patch(`/beds/${id}/status`, { status: s }), onSuccess: refresh });
  const canSet = canAny(['facilities.manage', 'ipd.beds.manage']);
  if (q.isPending) return <Spinner />;
  return (
    <section className="card p-4">
      <h2 className="mb-3 font-semibold">Beds</h2>
      <ErrorMessage error={add.error || status.error} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {q.data.data.map((b) => (
          <div key={b.id} className="rounded border border-slate-200 p-2 text-sm">
            <div className="flex items-center justify-between"><span className="font-medium">{b.label}</span><Badge tone={BED_TONE[b.status]}>{b.status.replace(/_/g, ' ')}</Badge></div>
            {canSet && b.status !== 'occupied' && (
              <select aria-label={`Status of ${b.label}`} className="input mt-2 min-h-8 text-xs" value={b.status} onChange={(e) => status.mutate({ id: b.id, s: e.target.value })}>
                {BED_STATUS.filter((s) => s !== 'occupied').map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
      <Can perm="facilities.manage">
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (label) add.mutate(); }}>
          <input className="input max-w-40" aria-label="New bed label" placeholder="Bed label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn-secondary">Add bed</button>
        </form>
      </Can>
    </section>
  );
}

function List({ q, cols, row }) {
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  if (!q.data.data.length) return <div className="card"><EmptyState title="Nothing here yet" /></div>;
  return (
    <div className="card overflow-x-auto">
      <table className="table-base">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{q.data.data.map((r) => <tr key={r.id}>{row(r).map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

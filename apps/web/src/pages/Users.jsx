import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { LICENCE_BODIES } from '@afyazuri/shared';
import { api, qs } from '../api.js';
import { Can, useAuth } from '../auth.jsx';
import { Badge, EmptyState, ErrorMessage, Field, PageHeader, Spinner, formatDateTime } from '../components/ui.jsx';

export default function Users() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [adding, setAdding] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ['users', q, status],
    queryFn: ({ pageParam }) => api.get(`/users${qs({ q, status, cursor: pageParam, limit: 25 })}`),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Staff"
        description="Accounts and role assignments at this facility."
        actions={<Can perm="users.manage"><button className="btn-primary" onClick={() => setAdding(true)}>Add staff</button></Can>}
      />
      {adding && <AddUser onClose={() => setAdding(false)} />}
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Search name or username" aria-label="Search staff" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="all">All</option>
        </select>
      </div>
      <div className="card overflow-x-auto">
        {list.isPending ? <Spinner /> : list.error ? <div className="p-4"><ErrorMessage error={list.error} /></div> : rows.length === 0 ? (
          <EmptyState title="No staff found">Try a different search.</EmptyState>
        ) : (
          <table className="table-base">
            <thead><tr><th>Name</th><th>Roles</th><th>Status</th><th>Last sign-in</th></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link to={`/admin/users/${u.id}`} className="font-medium text-brand-800 hover:underline">{u.fullName}</Link>
                    <div className="text-xs text-slate-600">{u.username}{u.cadre ? ` · ${u.cadre}` : ''}</div>
                  </td>
                  <td><div className="flex flex-wrap gap-1">{u.roles.map((r, i) => <Badge key={i}>{r.roleName}{r.departmentName ? ` · ${r.departmentName}` : ''}</Badge>)}</div></td>
                  <td>{u.status === 'disabled' ? <Badge tone="red">Disabled</Badge> : u.locked ? <Badge tone="amber">Locked</Badge> : <Badge tone="green">Active</Badge>}</td>
                  <td className="whitespace-nowrap text-slate-600">{formatDateTime(u.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {list.hasNextPage && (
        <button className="btn-secondary mt-3" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Load more</button>
      )}
    </>
  );
}

function AddUser({ onClose }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get('/roles') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments') });
  const form = useForm({ defaultValues: { mustChangePassword: true, role: 'records_clerk', departmentId: '' } });
  const create = useMutation({
    mutationFn: (v) =>
      api.post('/users', {
        username: v.username, fullName: v.fullName, email: v.email || null, phone: v.phone || null, cadre: v.cadre || null,
        licenceBody: v.licenceBody || null, licenceNumber: v.licenceNumber || null, password: v.password,
        mustChangePassword: v.mustChangePassword,
        roles: [{ role: v.role, facilityId: me.facility.id, departmentId: v.departmentId || null }],
      }, { 'Idempotency-Key': form.getValues('idemKey') }),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      nav(`/admin/users/${u.id}`);
    },
  });
  if (!form.getValues('idemKey')) form.setValue('idemKey', crypto.randomUUID());
  const r = form.register;

  return (
    <form className="card mb-4 space-y-4 p-4" onSubmit={form.handleSubmit((v) => create.mutate(v))}>
      <h2 className="font-semibold">New staff account</h2>
      <ErrorMessage error={create.error} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Full name" required><input className="input" {...r('fullName', { required: true })} /></Field>
        <Field label="Username" required hint="Letters, numbers, dots or dashes"><input className="input" autoCapitalize="none" {...r('username', { required: true })} /></Field>
        <Field label="Initial password" required hint="10+ chars with upper, lower, number and symbol"><input className="input" type="password" autoComplete="new-password" {...r('password', { required: true })} /></Field>
        <Field label="Phone"><input className="input" inputMode="tel" placeholder="0712 345 678" {...r('phone')} /></Field>
        <Field label="Email"><input className="input" type="email" {...r('email')} /></Field>
        <Field label="Cadre"><input className="input" placeholder="e.g. Registered Nurse" {...r('cadre')} /></Field>
        <Field label="Licensing body">
          <select className="input" {...r('licenceBody')}><option value="">None</option>{LICENCE_BODIES.map((b) => <option key={b}>{b}</option>)}</select>
        </Field>
        <Field label="Licence number"><input className="input" {...r('licenceNumber')} /></Field>
        <Field label="Role" required>
          <select className="input" {...r('role')}>{roles.data?.data.filter((x) => x.code !== 'super_admin').map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select>
        </Field>
        <Field label="Department" hint="Leave as 'All' for facility-wide access">
          <select className="input" {...r('departmentId')}><option value="">All departments</option>{depts.data?.data.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" {...r('mustChangePassword')} /> Require a new password at first sign-in</label>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={create.isPending}>Create account</button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

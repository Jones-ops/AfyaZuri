import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Can, useAuth } from '../auth.jsx';
import { Alert, Badge, ErrorMessage, Field, PageHeader, formatDateTime, PageSkeleton } from '../components/ui.jsx';

export default function UserDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const user = useQuery({ queryKey: ['user', id], queryFn: () => api.get(`/users/${id}`) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get('/roles') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments') });
  const [notice, setNotice] = useState(null);
  const [newRole, setNewRole] = useState({ role: 'records_clerk', departmentId: '' });

  const act = useMutation({
    mutationFn: ({ path, body, method = 'post' }) => api[method](`/users/${id}${path}`, body),
    onSuccess: (_d, v) => {
      setNotice(v.done);
      qc.invalidateQueries({ queryKey: ['user', id] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  if (user.isPending) return <PageSkeleton />;
  if (user.error) return <ErrorMessage error={user.error} />;
  const u = user.data;
  const here = me.facility ? u.roles.filter((r) => r.facilityId === me.facility.id) : u.roles;
  const setRoles = (list, done) =>
    act.mutate({
      method: 'put',
      path: '/roles',
      body: { roles: list.map((r) => ({ role: r.role, facilityId: r.facilityId, departmentId: r.departmentId })) },
      done,
    });

  return (
    <>
      <PageHeader title={u.fullName} description={`${u.username}${u.cadre ? ` · ${u.cadre}` : ''}`} />
      {notice && (
        <div className="mb-3">
          <Alert kind="success">{notice}</Alert>
        </div>
      )}
      <div className="mb-3">
        <ErrorMessage error={act.error} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Account</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-600">Status</dt>
            <dd>
              {u.status === 'disabled' ? (
                <Badge tone="red">Disabled</Badge>
              ) : u.locked ? (
                <Badge tone="amber">Locked</Badge>
              ) : (
                <Badge tone="green">Active</Badge>
              )}
              {u.disabledReason && <span className="ml-2 text-slate-600">{u.disabledReason}</span>}
            </dd>
            <dt className="text-slate-600">Licence</dt>
            <dd>{u.licenceBody ? `${u.licenceBody} ${u.licenceNumber ?? ''}` : '—'}</dd>
            <dt className="text-slate-600">Phone</dt>
            <dd>{u.phone ?? '—'}</dd>
            <dt className="text-slate-600">Email</dt>
            <dd>{u.email ?? '—'}</dd>
            <dt className="text-slate-600">2FA</dt>
            <dd>{u.totpEnabled ? 'Enabled' : 'Not enabled'}</dd>
            <dt className="text-slate-600">Last sign-in</dt>
            <dd>{formatDateTime(u.lastLoginAt)}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Can perm="users.disable">
              {u.status === 'active' ? (
                <button
                  className="btn-danger"
                  onClick={() => {
                    const reason = window.prompt('Reason for disabling this account');
                    if (reason)
                      act.mutate({
                        path: '/disable',
                        body: { reason },
                        done: 'Account disabled and signed out everywhere.',
                      });
                  }}
                >
                  Disable
                </button>
              ) : (
                <button
                  className="btn-secondary"
                  onClick={() => act.mutate({ path: '/enable', done: 'Account enabled.' })}
                >
                  Enable
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={() => act.mutate({ path: '/force-logout', done: 'All sessions ended.' })}
              >
                Force sign-out
              </button>
            </Can>
            <Can perm="users.manage">
              {u.locked && (
                <button
                  className="btn-secondary"
                  onClick={() => act.mutate({ path: '/unlock', done: 'Account unlocked.' })}
                >
                  Unlock
                </button>
              )}
              <button
                className="btn-secondary"
                onClick={() => {
                  const password = window.prompt('New temporary password (the user must change it at next sign-in)');
                  if (password)
                    act.mutate({
                      path: '/reset-password',
                      body: { password },
                      done: 'Password reset. The user must change it at next sign-in.',
                    });
                }}
              >
                Reset password
              </button>
            </Can>
          </div>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 font-semibold">{me.facility ? `Roles at ${me.facility.name}` : 'Roles'}</h2>
          {here.length === 0 && <p className="text-sm text-slate-600">No roles at this facility.</p>}
          <ul className="space-y-2">
            {here.map((r, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 text-sm"
              >
                <span>
                  {r.roleName}
                  <span className="text-slate-600"> · {r.departmentName ?? 'All departments'}</span>
                </span>
                <Can perm="users.manage">
                  <button
                    className="text-sm text-red-700 hover:underline"
                    onClick={() =>
                      setRoles(
                        here.filter((_, j) => j !== i),
                        'Role removed.',
                      )
                    }
                  >
                    Remove
                  </button>
                </Can>
              </li>
            ))}
          </ul>
          <Can perm="users.manage">
            <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Role">
                <select
                  className="input"
                  value={newRole.role}
                  onChange={(e) => setNewRole({ ...newRole, role: e.target.value })}
                >
                  {roles.data?.data
                    .filter((x) => x.code !== 'super_admin')
                    .map((x) => (
                      <option key={x.code} value={x.code}>
                        {x.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Department">
                <select
                  className="input"
                  value={newRole.departmentId}
                  onChange={(e) => setNewRole({ ...newRole, departmentId: e.target.value })}
                >
                  <option value="">All departments</option>
                  {depts.data?.data.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                className="btn-primary"
                onClick={() =>
                  setRoles(
                    [
                      ...here,
                      {
                        role: newRole.role,
                        facilityId: me.facility?.id ?? null,
                        departmentId: newRole.departmentId || null,
                      },
                    ],
                    'Role added.',
                  )
                }
              >
                Add role
              </button>
            </div>
          </Can>
        </section>
      </div>
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { ErrorMessage, PageHeader, Spinner } from '../components/ui.jsx';

/** Permission matrix: permissions down the side, roles across, with a sticky first column. */
export default function Roles() {
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api.get('/roles') });
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const { data: roles, permissionGroups } = q.data;
  const sets = roles.map((r) => new Set(r.permissions));

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="Seeded system roles. Clinical permissions are only ever held by clinical roles."
      />
      <div className="card max-h-[75vh] overflow-auto">
        <table className="table-base">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 min-w-64">Permission</th>
              {roles.map((r) => (
                <th key={r.code} className="min-w-24 text-center normal-case" title={r.description}>
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(permissionGroups).map(([group, perms]) => [
              <tr key={group}>
                <td colSpan={roles.length + 1} className="sticky left-0 bg-slate-100 font-semibold capitalize">
                  {group}
                </td>
              </tr>,
              ...Object.entries(perms).map(([code, desc]) => (
                <tr key={code}>
                  <td className="sticky left-0 bg-white">
                    <div className="font-mono text-xs">{code}</div>
                    <div className="text-xs text-slate-600">{desc}</div>
                  </td>
                  {sets.map((s, i) => (
                    <td key={roles[i].code} className="text-center">
                      {s.has(code) ? (
                        <span aria-label="granted" className="text-brand-700">
                          ●
                        </span>
                      ) : (
                        <span className="sr-only">not granted</span>
                      )}
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </>
  );
}

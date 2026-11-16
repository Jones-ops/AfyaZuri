import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Badge, PageHeader } from '../components/ui.jsx';

const LINKS = [
  {
    to: '/admin/users',
    perm: 'users.read',
    title: 'Staff',
    body: 'Accounts, role assignments, lockouts and sessions.',
  },
  {
    to: '/admin/facility',
    perm: 'facilities.read',
    title: 'Facility setup',
    body: 'Departments, service points, wards and beds.',
  },
  { to: '/admin/roles', perm: 'roles.read', title: 'Roles & permissions', body: 'What each role can see and do.' },
  { to: '/admin/audit', perm: 'audit.read', title: 'Audit log', body: 'Who did what, when, and from where.' },
];

export default function Home() {
  const { me, can } = useAuth();
  const links = LINKS.filter((l) => can(l.perm));
  return (
    <>
      <PageHeader title={`Karibu, ${me.user.fullName}`} description={me.facility?.name ?? 'No facility selected yet'} />
      <section className="card mb-6 p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Your access here</h2>
        <div className="flex flex-wrap gap-2">
          {me.roles.map((r) => (
            <Badge key={r} tone="teal">
              {r.replace(/_/g, ' ')}
            </Badge>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-600">{me.permissions.length} permissions at this facility.</p>
      </section>
      {links.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className="card block p-4 hover:border-brand-600">
              <h2 className="font-semibold text-slate-900">{l.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{l.body}</p>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-600">
          Clinical and departmental workspaces for your role are added as each module is delivered.
        </p>
      )}
    </>
  );
}

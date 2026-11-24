import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Photo, PhotoCredit, PHOTOS } from '../components/Photo.jsx';
import { Badge } from '../components/ui.jsx';

const WORK = [
  {
    to: '/patients',
    perm: 'patients.read',
    title: 'Patients',
    body: 'Find, register and check in patients.',
    icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  },
  {
    to: '/opd',
    perm: 'opd.queue.read',
    title: 'Queues',
    body: 'Triage, consultation and cashier queues.',
    icon: 'M4 6h16M4 12h10M4 18h6',
  },
  {
    to: '/cashier',
    perm: 'billing.shift.manage',
    title: 'Cashier desk',
    body: 'Open your shift, take payments, close out.',
    icon: 'M3 7h18v10H3zM7 12h.01M17 12h.01M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  },
  {
    to: '/billing',
    perm: 'billing.read',
    title: 'Bills',
    body: 'Visit bills, balances and receipts.',
    icon: 'M7 3h10v18l-2.5-2-2.5 2-2.5-2L7 21zM10 8h4M10 12h4',
  },
  {
    to: '/lab',
    perm: 'lab.read',
    title: 'Laboratory',
    body: 'Collect, receive, result and verify tests.',
    icon: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7 15h10',
  },
  {
    to: '/pharmacy',
    perm: 'pharmacy.read',
    title: 'Pharmacy',
    body: 'Prescriptions to dispense, with safety checks.',
    icon: 'M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7ZM8.5 8.5l7 7',
  },
  {
    to: '/inventory',
    perm: 'inventory.read',
    title: 'Stock',
    body: 'Stock on hand, deliveries, expiry and reorders.',
    icon: 'M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10',
  },
  {
    to: '/reports/finance',
    perm: 'reports.financial.read',
    title: 'Finance reports',
    body: 'Daily revenue, collections and debtor ageing.',
    icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  },
];
const ADMIN = [
  {
    to: '/admin/users',
    perm: 'users.read',
    title: 'Staff',
    body: 'Accounts, role assignments, lockouts and sessions.',
    icon: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 9a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6',
  },
  {
    to: '/admin/facility',
    perm: 'facilities.read',
    title: 'Facility setup',
    body: 'Departments, service points, wards and beds.',
    icon: 'M4 21V7l8-4 8 4v14M9 21v-5h6v5M12 8v4M10 10h4',
  },
  {
    to: '/admin/roles',
    perm: 'roles.read',
    title: 'Roles & permissions',
    body: 'What each role can see and do.',
    icon: 'M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z',
  },
  {
    to: '/admin/audit',
    perm: 'audit.read',
    title: 'Audit log',
    body: 'Who did what, when, and from where.',
    icon: 'M8 4h11v16H8zM5 8h3M5 12h3M5 16h3M11 9h5M11 13h5',
  },
];

function Tile({ l, i }) {
  return (
    <Link
      to={l.to}
      className="card group flex gap-3 p-4"
      style={{ animation: `az-page-in 320ms ${80 + i * 45}ms cubic-bezier(0.22,1,0.36,1) both` }}
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-brand-800 bg-gradient-to-b from-brand-500 to-brand-700 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_2px_6px_-2px_rgb(15_118_110/0.7)] transition-transform duration-300 group-hover:-rotate-3 group-hover:scale-105">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d={l.icon} />
        </svg>
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-slate-900">{l.title}</span>
        <span className="mt-0.5 block text-sm text-slate-600">{l.body}</span>
      </span>
    </Link>
  );
}

export default function Home() {
  const { me, can } = useAuth();
  const work = WORK.filter((l) => can(l.perm));
  const admin = ADMIN.filter((l) => can(l.perm));
  const photo = PHOTOS.maternityMidwife;
  return (
    <>
      <section className="relative mb-6 flex min-h-44 overflow-hidden rounded-xl border border-brand-900/30 bg-brand-900 shadow-[0_2px_4px_rgb(15_23_42/0.1),0_18px_36px_-18px_rgb(15_23_42/0.55)] sm:min-h-52">
        <Photo photo={photo} sizes="(min-width: 1024px) 70vw, 100vw" position="70% 80%" priority />
        <div
          className="absolute inset-0 bg-gradient-to-r from-brand-900/90 via-brand-900/55 to-transparent"
          aria-hidden
        />
        <div className="absolute inset-0 rounded-xl shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]" aria-hidden />
        <div className="relative flex flex-1 flex-col justify-end p-5 text-white sm:p-6">
          <h1 className="text-2xl font-semibold [text-shadow:0_1px_3px_rgb(0_0_0/0.45)]">Karibu, {me.user.fullName}</h1>
          <p className="mt-1 text-sm text-brand-50/90">{me.facility?.name ?? 'No facility selected yet'}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {me.roles.map((r) => (
              <Badge key={r} tone="teal">
                {r.replace(/_/g, ' ')}
              </Badge>
            ))}
          </div>
        </div>
      </section>
      <p className="-mt-5 mb-6 text-right text-[10px] text-slate-500">
        <PhotoCredit photo={photo} />
      </p>

      {work.length > 0 && (
        <section className="mb-6" aria-labelledby="work-h">
          <h2 id="work-h" className="mb-3 text-sm font-semibold tracking-wide text-slate-600 uppercase">
            Your work
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {work.map((l, i) => (
              <Tile key={l.to} l={l} i={i} />
            ))}
          </div>
        </section>
      )}
      {admin.length > 0 && (
        <section className="mb-6" aria-labelledby="admin-h">
          <h2 id="admin-h" className="mb-3 text-sm font-semibold tracking-wide text-slate-600 uppercase">
            Administration
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {admin.map((l, i) => (
              <Tile key={l.to} l={l} i={i + work.length} />
            ))}
          </div>
        </section>
      )}
      {work.length + admin.length === 0 && (
        <p className="text-sm text-slate-600">
          Clinical and departmental workspaces for your role are added as each module is delivered.
        </p>
      )}
      <p className="text-xs text-slate-500">{me.permissions.length} permissions at this facility.</p>
    </>
  );
}

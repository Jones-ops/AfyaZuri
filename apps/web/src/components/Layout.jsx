import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { setLanguage } from '../i18n.js';

const NAV = [
  { to: '/', key: 'home', perm: null, end: true },
  { to: '/patients', key: 'patients', perm: 'patients.read' },
  { to: '/opd', key: 'queues', perm: 'opd.queue.read' },
  { to: '/cashier', key: 'cashier', perm: 'billing.shift.manage' },
  { to: '/billing', key: 'billing', perm: 'billing.read', end: true },
  {
    to: '/billing/approvals',
    key: 'approvals',
    perm: ['billing.waiver.approve', 'billing.refund.approve', 'billing.payment.receive'],
  },
  { to: '/billing/setup', key: 'billingSetup', perm: 'billing.pricelist.manage' },
  { to: '/inventory', key: 'stock', perm: 'inventory.read' },
  { to: '/reports/finance', key: 'financeReports', perm: 'reports.financial.read' },
  { to: '/admin/break-glass', key: 'breakGlass', perm: 'audit.read' },
  { to: '/admin/users', key: 'users', perm: 'users.read' },
  { to: '/admin/roles', key: 'roles', perm: 'roles.read' },
  { to: '/admin/facility', key: 'facility', perm: 'facilities.read' },
  { to: '/admin/audit', key: 'audit', perm: 'audit.read' },
  { to: '/account', key: 'account', perm: null },
];

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function FacilitySwitcher() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (facilityId) => api.post('/auth/switch-facility', { facilityId }),
    onSuccess: () => qc.invalidateQueries(),
  });
  if (!me?.facility) return null;
  if (me.facilities.length < 2) return <span className="truncate text-sm text-brand-50">{me.facility.name}</span>;
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-brand-50">
      <span className="sr-only">Facility</span>
      <select
        className="max-w-56 truncate rounded border border-brand-600 bg-brand-800 px-2 py-1 text-white"
        value={me.facility.id}
        disabled={m.isPending}
        onChange={(e) => m.mutate(e.target.value)}
      >
        {me.facilities.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function Layout() {
  const { t, i18n } = useTranslation();
  const { me, can, canAny, signOut } = useAuth();
  const online = useOnline();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // "/" anywhere (outside a text field) jumps to patient search.
  const canSearch = can('patients.read');
  useEffect(() => {
    if (!canSearch) return undefined;
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (
        e.key !== '/' ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) ||
        e.target?.isContentEditable
      )
        return;
      e.preventDefault();
      if (location.pathname === '/patients') document.getElementById('patient-search')?.focus();
      else navigate('/patients');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canSearch, location.pathname, navigate]);

  const items = NAV.filter((n) => !n.perm || (Array.isArray(n.perm) ? canAny(n.perm) : can(n.perm)));

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">
        Skip to content
      </a>
      <header className="app-bar no-print sticky top-0 z-30 flex h-14 items-center gap-3 px-4 text-white">
        <button
          className="rounded p-2 hover:bg-brand-800 lg:hidden"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
            <path d="M2 4h16v2H2zM2 9h16v2H2zM2 14h16v2H2z" />
          </svg>
        </button>
        <span className="flex items-center gap-2 font-semibold tracking-tight [text-shadow:0_-1px_0_rgb(0_0_0/0.25)]">
          <img
            src="/icon.svg"
            alt=""
            width="24"
            height="24"
            className="rounded-md bg-white/90 p-0.5 shadow-[inset_0_1px_0_#fff,0_1px_2px_rgb(0_0_0/0.3)]"
          />
          {t('appName')}
        </span>
        <div className="hidden min-w-0 sm:block">
          <FacilitySwitcher />
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${online ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}
            role="status"
          >
            <span className={`h-2 w-2 rounded-full ${online ? 'bg-emerald-600' : 'bg-amber-600'}`} aria-hidden />
            {online ? t('online') : t('offline')}
          </span>
          <select
            aria-label="Language"
            className="rounded border border-brand-600 bg-brand-800 px-1 py-1 text-xs"
            value={i18n.language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="en">EN</option>
            <option value="sw">SW</option>
          </select>
          <span className="hidden text-sm md:inline">{me?.user.fullName}</span>
          <button className="rounded px-2 py-1 text-sm hover:bg-brand-800" onClick={signOut}>
            {t('signOut')}
          </button>
        </div>
      </header>

      <div className="flex flex-1">
        <nav
          aria-label="Main"
          className={`no-print fixed inset-y-14 left-0 z-20 w-60 border-r border-slate-200 bg-gradient-to-b from-white to-slate-50 p-3 shadow-[inset_-1px_0_0_#fff] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:static lg:translate-x-0 ${menuOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}
        >
          <div className="mb-3 sm:hidden">
            <FacilitySwitcherMobile />
          </div>
          <ul className="space-y-1">
            {items.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end}
                  className={({ isActive }) =>
                    `nav-item flex min-h-10 items-center rounded-md px-3 text-sm font-medium ${isActive ? 'text-brand-800' : 'text-slate-700 hover:bg-white hover:shadow-[0_1px_2px_rgb(15_23_42/0.08)]'}`
                  }
                >
                  {t(`nav.${n.key}`)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {menuOpen && (
          <div
            className="fixed inset-0 top-14 z-10 animate-[az-page-in_200ms_ease-out_both] bg-slate-900/30 backdrop-blur-[1px] lg:hidden"
            onClick={() => setMenuOpen(false)}
          />
        )}
        <main id="main" className="min-w-0 flex-1 p-4 sm:p-6">
          <div key={location.pathname} className="page-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function FacilitySwitcherMobile() {
  const { me } = useAuth();
  return me?.facility ? <p className="text-xs text-slate-600">{me.facility.name}</p> : null;
}

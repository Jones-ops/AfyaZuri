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
  { to: '/billing', key: 'billing', perm: 'billing.read', end: true },
  { to: '/billing/setup', key: 'billingSetup', perm: 'billing.pricelist.manage' },
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
  const { me, can, signOut } = useAuth();
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

  const items = NAV.filter((n) => !n.perm || can(n.perm));

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-2">
        Skip to content
      </a>
      <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 bg-brand-700 px-4 text-white">
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
        <span className="font-semibold tracking-tight">{t('appName')}</span>
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
          className={`no-print fixed inset-y-14 left-0 z-20 w-60 border-r border-slate-200 bg-white p-3 transition-transform lg:static lg:translate-x-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}
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
                    `flex min-h-10 items-center rounded-md px-3 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-700 hover:bg-slate-100'}`
                  }
                >
                  {t(`nav.${n.key}`)}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {menuOpen && (
          <div className="fixed inset-0 top-14 z-10 bg-slate-900/30 lg:hidden" onClick={() => setMenuOpen(false)} />
        )}
        <main id="main" className="min-w-0 flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function FacilitySwitcherMobile() {
  const { me } = useAuth();
  return me?.facility ? <p className="text-xs text-slate-600">{me.facility.name}</p> : null;
}

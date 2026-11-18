import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Badge } from '../ui.jsx';

const TABS = [
  ['/inventory', 'Stock on hand', 'inventory.read', true],
  ['/inventory/receive', 'Receive goods', 'inventory.receive'],
  ['/inventory/purchase-orders', 'Purchase orders', 'inventory.read'],
  ['/inventory/items', 'Items', 'inventory.read'],
  ['/inventory/expiry', 'Expiry', 'inventory.read'],
  ['/inventory/movements', 'Ledger', 'inventory.read'],
];

/** Tabs across the inventory pages. */
export function InventoryNav() {
  const { can } = useAuth();
  return (
    <nav aria-label="Inventory" className="no-print mb-4 flex flex-wrap gap-1 border-b border-slate-200 pb-2">
      {TABS.filter(([, , perm]) => can(perm)).map(([to, label, , end]) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `nav-item rounded-md px-3 py-1.5 text-sm font-medium ${isActive ? 'text-brand-800' : 'text-slate-700 hover:bg-white'}`
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function useStores() {
  return useQuery({ queryKey: ['stores'], queryFn: () => api.get('/stores'), staleTime: 60_000 });
}

/** Store picker; remembers the last store chosen on this device. */
export function StoreSelect({ value, onChange, label = 'Store', filter = () => true }) {
  const stores = useStores();
  const list = (stores.data?.data ?? []).filter((s) => s.active && filter(s));
  useEffect(() => {
    if (value || !list.length) return;
    let saved = null;
    try {
      saved = localStorage.getItem('az.store');
    } catch {
      /* private mode */
    }
    onChange((list.find((s) => s.id === saved) ?? list[0]).id);
  }, [value, list, onChange]);
  return (
    <label className="block">
      <span className="label">{label}</span>
      <select
        className="input"
        value={value ?? ''}
        onChange={(e) => {
          try {
            localStorage.setItem('az.store', e.target.value);
          } catch {
            /* private mode */
          }
          onChange(e.target.value);
        }}
      >
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export const STATUS_TONE = { ok: 'green', low: 'amber', out: 'red' };
export function StockStatus({ status }) {
  return <Badge tone={STATUS_TONE[status]}>{status === 'ok' ? 'in stock' : status === 'low' ? 'low' : 'out'}</Badge>;
}

/** Search the item master; calls onPick(item). */
export function ItemPicker({ onPick, label = 'Item', category, autoFocus }) {
  const id = useId();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const res = useQuery({
    queryKey: ['items', 'search', q, category],
    queryFn: () => api.get(`/items${qs({ q, category, active: 'true', limit: 15 })}`),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
  const list = res.data?.data ?? [];
  return (
    <div className="relative">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="input"
        placeholder="Type 2+ letters: name, generic or code"
        autoComplete="off"
        autoFocus={autoFocus}
        value={q}
        role="combobox"
        aria-expanded={open && list.length > 0}
        aria-controls={`${id}-list`}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && list.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="pop-in card absolute z-20 mt-1 max-h-72 w-full overflow-auto p-1 text-sm"
        >
          {list.map((i) => (
            <li key={i.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left hover:bg-brand-50"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(i);
                  setQ('');
                  setOpen(false);
                }}
              >
                <span className="font-medium">{i.name}</span>{' '}
                <span className="font-mono text-xs text-slate-600">{i.code}</span>
                {i.drug && <span className="block text-xs text-slate-600">{i.drug.genericName}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

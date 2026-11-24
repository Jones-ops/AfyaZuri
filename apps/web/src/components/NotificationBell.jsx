import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { formatDateTime } from './ui.jsx';

const TONE = {
  critical: 'border-l-4 border-red-600 bg-red-50',
  warning: 'border-l-4 border-amber-500 bg-amber-50',
  info: 'border-l-4 border-sky-400',
};

/** Header bell: my unread notifications (critical results first in urgency), polled every 30 s. */
export default function NotificationBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get('/notifications'),
    refetchInterval: 30_000,
  });
  const read = useMutation({
    mutationFn: (id) => api.post(id ? `/notifications/${id}/read` : '/notifications/read-all'),
    onSuccess: (data) => qc.setQueryData(['notifications'], data),
  });
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const unread = q.data?.unread ?? 0;
  const critical = (q.data?.data ?? []).some((n) => !n.readAt && n.severity === 'critical');
  return (
    <div className="relative" ref={box}>
      <button
        className={`relative rounded p-2 hover:bg-brand-800 ${critical ? 'animate-pulse' : ''}`}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span
            className={`absolute -top-0.5 -right-0.5 min-w-5 rounded-full px-1 text-center text-[11px] leading-5 font-bold text-white ${critical ? 'bg-red-600' : 'bg-amber-600'}`}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="pop-in card absolute right-0 z-40 mt-2 max-h-[70vh] w-[22rem] max-w-[90vw] overflow-auto p-2 text-slate-900"
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <strong className="text-sm">Notifications</strong>
            {unread > 0 && (
              <button className="text-xs text-brand-800 hover:underline" onClick={() => read.mutate(null)}>
                Mark all read
              </button>
            )}
          </div>
          {(q.data?.data ?? []).length === 0 && <p className="p-3 text-sm text-slate-600">Nothing yet.</p>}
          <ul className="space-y-1">
            {(q.data?.data ?? []).map((n) => (
              <li key={n.id}>
                <button
                  className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50 ${TONE[n.severity]} ${n.readAt ? 'opacity-60' : ''}`}
                  onClick={() => {
                    if (!n.readAt) read.mutate(n.id);
                    setOpen(false);
                    if (n.link) navigate(n.link);
                  }}
                >
                  <span className="block font-medium">{n.title}</span>
                  {n.body && <span className="block text-xs text-slate-700">{n.body}</span>}
                  <span className="block text-[11px] text-slate-500">{formatDateTime(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

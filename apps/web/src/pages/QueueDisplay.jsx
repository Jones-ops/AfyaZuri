import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Full-screen waiting-room display. Shows ticket numbers only — never names —
 * so it is safe on a public screen.
 */
export default function QueueDisplay() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ['display', id],
    queryFn: () => api.get(`/queues/${id}/display`),
    refetchInterval: 5_000,
  });
  const d = q.data;
  const [latest, ...earlier] = d?.nowServing ?? [];

  return (
    <div className="flex min-h-screen flex-col bg-brand-900 p-8 text-white">
      <header className="flex items-baseline justify-between">
        <h1 className="text-4xl font-bold">{d?.servicePointName ?? 'Queue'}</h1>
        <p className="text-2xl">
          Waiting / Wanaosubiri: <strong>{d?.waiting ?? '–'}</strong>
        </p>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center" aria-live="assertive">
        <p className="text-3xl text-brand-100">Now serving · Anayehudumiwa sasa</p>
        <p className="mt-4 font-mono text-[12rem] leading-none font-bold">{latest?.label ?? '—'}</p>
      </main>
      {earlier.length > 0 && (
        <footer className="flex flex-wrap justify-center gap-6 font-mono text-5xl text-brand-100">
          {earlier.map((t) => (
            <span key={t.label}>{t.label}</span>
          ))}
        </footer>
      )}
      {q.error && <p className="mt-4 text-center text-xl text-amber-200">Reconnecting…</p>}
    </div>
  );
}

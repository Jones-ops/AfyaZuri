import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Can } from '../auth.jsx';
import { Badge, EmptyState, ErrorMessage, PageHeader, Spinner } from '../components/ui.jsx';

const MATCH_LABEL = {
  mrn: 'MRN',
  phone: 'Phone',
  identifier: 'ID number',
  similar_name: 'similar spelling',
  name: null,
};

/** Debounce a value so search runs after the user pauses typing (fewer requests on slow links). */
function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function Patients() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const term = useDebounced(q.trim());
  const input = useRef(null);
  const nav = useNavigate();

  useEffect(() => {
    setParams(term ? { q: term } : {}, { replace: true });
  }, [term, setParams]);
  useEffect(() => input.current?.focus(), []);

  const search = useInfiniteQuery({
    queryKey: ['patients', term],
    queryFn: ({ pageParam }) => api.get(`/patients${qs({ q: term, cursor: pageParam })}`),
    initialPageParam: undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    enabled: term.length >= 2,
  });
  const rows = search.data?.pages.flatMap((p) => p.data) ?? [];
  const hint = search.data?.pages[0]?.hint;

  return (
    <>
      <PageHeader
        title="Patients"
        description="Search by name, MRN, phone, national ID or SHA number."
        actions={
          <Can perm="patients.create">
            <Link to="/patients/new" className="btn-primary">
              Register patient
            </Link>
          </Can>
        }
      />
      <form
        role="search"
        className="mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (rows.length === 1) nav(`/patients/${rows[0].id}`);
        }}
      >
        <label htmlFor="patient-search" className="sr-only">
          Search patients
        </label>
        <input
          id="patient-search"
          ref={input}
          className="input max-w-xl text-base"
          placeholder="e.g. Akinyi Odera, 99001-2026-000042, 0712 345 678"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />
      </form>
      {rows.length > 0 && hint && (
        <p className="mb-2 text-sm text-amber-900" role="status">
          {hint}
        </p>
      )}
      <div className="card overflow-x-auto">
        {term.length < 2 ? (
          <EmptyState title="Start typing to search">Results appear as you type.</EmptyState>
        ) : search.isPending ? (
          <Spinner label="Searching…" />
        ) : search.error ? (
          <div className="p-4">
            <ErrorMessage error={search.error} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No matching patients">{hint ?? 'Check the spelling, or register the patient.'}</EmptyState>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Patient</th>
                <th>MRN</th>
                <th>Age / sex</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td>
                    <Link to={`/patients/${p.id}`} className="font-medium text-brand-800 hover:underline">
                      {p.fullName}
                    </Link>
                    {p.isRestricted && (
                      <span className="ml-2">
                        <Badge tone="amber">Restricted</Badge>
                      </span>
                    )}
                    {MATCH_LABEL[p.matchedBy] && (
                      <div className="text-xs text-slate-600">Matched by {MATCH_LABEL[p.matchedBy]}</div>
                    )}
                  </td>
                  <td className="font-mono whitespace-nowrap">{p.mrn}</td>
                  <td className="whitespace-nowrap">
                    {p.age} · {p.sex}
                  </td>
                  <td className="whitespace-nowrap text-slate-600">{p.phoneMasked ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {search.hasNextPage && (
        <button
          className="btn-secondary mt-3"
          onClick={() => search.fetchNextPage()}
          disabled={search.isFetchingNextPage}
        >
          More results
        </button>
      )}
    </>
  );
}

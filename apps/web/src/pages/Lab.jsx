import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Can } from '../auth.jsx';
import { ResultForm, VerifyPanel } from '../components/lab/Results.jsx';
import {
  Alert,
  Badge,
  EmptyState,
  ErrorMessage,
  Field,
  PageHeader,
  Spinner,
  formatDateTime,
} from '../components/ui.jsx';

const STAGES = [
  ['collect', 'To collect'],
  ['receive', 'In transit'],
  ['result', 'To result'],
  ['verify', 'To verify'],
  ['done', 'Released (24 h)'],
];
const PRIORITY_TONE = { stat: 'red', urgent: 'amber', routine: 'slate' };

/** Scan (or type) a tube's barcode to receive it in the lab. */
function ReceiveBox() {
  const qc = useQueryClient();
  const [accession, setAccession] = useState('');
  const [last, setLast] = useState(null);
  const input = useRef(null);
  const m = useMutation({
    mutationFn: (a) => api.post('/lab-samples/receive', { accession: a }),
    onSuccess: (s) => {
      setLast(s);
      setAccession('');
      qc.invalidateQueries({ queryKey: ['lab-worklist'] });
      input.current?.focus();
    },
    onError: () => input.current?.select(),
  });
  return (
    <form
      className="card mb-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (accession.trim()) m.mutate(accession.trim());
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <Field label="Scan a sample barcode" hint="A barcode scanner types the accession and presses Enter.">
            <input
              ref={input}
              className="input font-mono uppercase"
              autoFocus
              value={accession}
              onChange={(e) => setAccession(e.target.value)}
            />
          </Field>
        </div>
        <button className="btn-primary" disabled={m.isPending}>
          Receive
        </button>
      </div>
      <div className="mt-2">
        <ErrorMessage error={m.error} />
        {last && !m.error && (
          <Alert kind="success">
            Received {last.accession}: {last.patient.name} ({last.patient.mrn}) — {last.tests.join(', ')} in{' '}
            {last.container}.
          </Alert>
        )}
      </div>
    </form>
  );
}

function OrderCard({ o, stage }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(null);
  const navigate = useNavigate();
  const collect = useMutation({
    mutationFn: () => api.post(`/lab-orders/${o.orderId}/collect`, {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['lab-worklist'] });
      navigate(`/lab/labels?ids=${r.data.map((s) => s.id).join(',')}`);
    },
  });
  const reject = useMutation({
    mutationFn: ({ sampleId, reason }) => api.post(`/lab-samples/${sampleId}/reject`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lab-worklist'] }),
  });
  const samples = [...new Map(o.tests.filter((t) => t.sampleId).map((t) => [t.sampleId, t])).values()];
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{o.orderNumber}</span>
        <Badge tone={PRIORITY_TONE[o.priority]}>{o.priority}</Badge>
        <span className="font-medium">{o.patient}</span>
        <span className="font-mono text-xs text-slate-600">{o.mrn}</span>
        <span className="ml-auto text-xs text-slate-600">ordered {formatDateTime(o.orderedAt)}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {o.tests.map((t) => (
          <Badge key={t.id} tone={t.overdue ? 'red' : 'slate'}>
            {t.name}
            {t.accession ? ` · ${t.accession}` : ''}
            {t.overdue ? ' · overdue' : ''}
          </Badge>
        ))}
      </div>
      {stage === 'collect' && (
        <Can perm="lab.samples.collect">
          <button className="btn-primary mt-2 min-h-9" disabled={collect.isPending} onClick={() => collect.mutate()}>
            Collect samples and print labels
          </button>
        </Can>
      )}
      {['receive', 'result'].includes(stage) && (
        <Can perm="lab.samples.receive">
          <div className="mt-2 flex flex-wrap gap-2">
            {samples.map((s) => (
              <button
                key={s.sampleId}
                className="btn-secondary min-h-8 px-3 text-xs"
                onClick={() => {
                  const reason = window.prompt(`Why reject ${s.accession}? (e.g. haemolysed, clotted, unlabelled)`);
                  if (reason) reject.mutate({ sampleId: s.sampleId, reason });
                }}
              >
                Reject {s.accession}
              </button>
            ))}
          </div>
        </Can>
      )}
      {stage === 'result' && (
        <Can perm="lab.results.enter">
          <div className="mt-2 flex flex-wrap gap-2">
            {o.tests.map((t) => (
              <button
                key={t.id}
                className="btn-secondary min-h-8 px-3 text-xs"
                aria-expanded={open === t.id}
                onClick={() => setOpen(open === t.id ? null : t.id)}
              >
                Enter results: {t.name}
              </button>
            ))}
          </div>
          {open && (
            <div className="mt-2">
              <ResultForm itemId={open} onDone={() => setOpen(null)} />
            </div>
          )}
        </Can>
      )}
      {stage === 'verify' && (
        <Can perm="lab.results.verify">
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {o.tests.map((t) => (
              <VerifyPanel key={t.id} itemId={t.id} />
            ))}
          </div>
        </Can>
      )}
      {stage === 'done' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Link className="btn-secondary min-h-8 px-3 text-xs" to={`/lab/report/${o.orderId}`}>
            Result report
          </Link>
          <Can perm="lab.results.verify">
            {o.tests.map((t) => (
              <button
                key={t.id}
                className="btn-secondary min-h-8 px-3 text-xs"
                onClick={() => setOpen(open === t.id ? null : t.id)}
              >
                Amend {t.name}
              </button>
            ))}
          </Can>
        </div>
      )}
      {stage === 'done' && open && (
        <div className="mt-2">
          <ResultForm itemId={open} amend onDone={() => setOpen(null)} />
        </div>
      )}
      <ErrorMessage error={collect.error ?? reject.error} />
    </li>
  );
}

/** The lab's worklist, stage by stage. STAT orders come first; overdue tests are flagged. */
export default function Lab() {
  const [params, setParams] = useSearchParams();
  const stage = STAGES.some(([s]) => s === params.get('stage')) ? params.get('stage') : 'collect';
  const setStage = (s) => setParams({ stage: s });
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['lab-worklist', stage, q],
    queryFn: () => api.get(`/lab/worklist${qs({ stage, q: q || undefined })}`),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader title="Laboratory" description="Collect, receive, result and verify. STAT orders are listed first." />
      <div role="tablist" aria-label="Stage" className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 pb-2">
        {STAGES.map(([s, l]) => (
          <button
            key={s}
            role="tab"
            aria-selected={stage === s}
            aria-current={stage === s ? 'page' : undefined}
            className={`nav-item rounded-md px-3 py-1.5 text-sm font-medium ${stage === s ? 'text-brand-800' : 'text-slate-700 hover:bg-white'}`}
            onClick={() => setStage(s)}
          >
            {l}
          </button>
        ))}
      </div>
      {stage === 'receive' && (
        <Can perm="lab.samples.receive">
          <ReceiveBox />
        </Can>
      )}
      <div className="mb-3 max-w-md">
        <Field label="Find">
          <input
            className="input"
            placeholder="Name, MRN, order or accession"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </Field>
      </div>
      <section className="card" aria-label="Lab worklist">
        {list.isPending ? (
          <Spinner label="Loading the worklist…" />
        ) : list.error ? (
          <ErrorMessage error={list.error} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="Nothing here" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {list.data.data.map((o) => (
              <OrderCard key={o.orderId} o={o} stage={stage} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

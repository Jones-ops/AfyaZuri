import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../api.js';
import { Can, useAuth } from '../../auth.jsx';
import { Badge, ErrorMessage, Field, formatDateTime } from '../ui.jsx';

const SOAP = [
  ['subjective', 'Subjective'],
  ['objective', 'Objective'],
  ['assessment', 'Assessment'],
  ['plan', 'Plan'],
];

/** Write SOAP notes from templates; signed notes are locked and corrected by addenda. */
export default function NotesPanel({ encounterId, notes, onChange }) {
  const { me } = useAuth();
  const templates = useQuery({
    queryKey: ['note-templates'],
    queryFn: () => api.get('/note-templates'),
    staleTime: Infinity,
  });
  const [templateCode, setTemplateCode] = useState('opd_general');
  const [text, setText] = useState({ subjective: '', objective: '', assessment: '', plan: '' });
  const clientId = useRef(crypto.randomUUID());
  const template = templates.data?.data.find((t) => t.code === templateCode);
  const save = useMutation({
    mutationFn: (sign) =>
      api.post(`/encounters/${encounterId}/notes`, {
        ...text,
        templateCode,
        noteType: template?.noteType ?? 'soap',
        sign,
        clientId: clientId.current,
      }),
    onSuccess: () => {
      clientId.current = crypto.randomUUID();
      setText({ subjective: '', objective: '', assessment: '', plan: '' });
      onChange();
    },
  });
  const empty = !Object.values(text).some((v) => v.trim());

  return (
    <section className="card p-4" aria-labelledby="notes-h">
      <h2 id="notes-h" className="mb-3 font-semibold">
        Clinical notes
      </h2>
      <Can perm="emr.notes.write">
        <div className="space-y-3">
          <Field label="Template">
            <select className="input max-w-sm" value={templateCode} onChange={(e) => setTemplateCode(e.target.value)}>
              {templates.data?.data.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid gap-3 lg:grid-cols-2">
            {SOAP.map(([k, label]) => (
              <Field key={k} label={label}>
                <textarea
                  className="input min-h-24 py-2"
                  placeholder={template?.prompts[k]}
                  value={text[k]}
                  onChange={(e) => setText({ ...text, [k]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          <ErrorMessage error={save.error} />
          <div className="flex flex-wrap gap-2">
            <Can perm="emr.notes.sign">
              <button className="btn-primary" disabled={empty || save.isPending} onClick={() => save.mutate(true)}>
                Save and sign
              </button>
            </Can>
            <button className="btn-secondary" disabled={empty || save.isPending} onClick={() => save.mutate(false)}>
              Save draft
            </button>
          </div>
          <p className="text-xs text-slate-600">Signed notes are locked. Corrections are added as addenda.</p>
        </div>
      </Can>
      {notes.length > 0 && (
        <ul className="mt-4 space-y-3">
          {[...notes].reverse().map((n) => (
            <Note key={n.id} note={n} mine={n.authorId === me.user.id} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Note({ note: n, mine, onChange }) {
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState('');
  const addendum = useMutation({
    mutationFn: () => api.post(`/notes/${n.id}/addenda`, { body }),
    onSuccess: () => {
      setAdding(false);
      setBody('');
      onChange?.();
    },
  });
  const sign = useMutation({ mutationFn: () => api.post(`/notes/${n.id}/sign`), onSuccess: () => onChange?.() });
  const markError = useMutation({
    mutationFn: (reason) => api.post(`/clinical/notes/${n.id}/entered-in-error`, { reason }),
    onSuccess: () => onChange?.(),
  });
  return (
    <li className={`rounded border border-slate-200 p-3 text-sm ${n.enteredInError ? 'opacity-60' : ''}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Badge tone={n.status === 'signed' ? 'green' : 'amber'}>{n.status}</Badge>
          <span className="font-medium">{n.author?.name}</span>
          {n.author?.licence && <span className="text-xs text-slate-600">{n.author.licence}</span>}
        </span>
        <span className="text-xs text-slate-600">{formatDateTime(n.signedAt ?? n.createdAt)}</span>
      </div>
      <dl className={`space-y-1 ${n.enteredInError ? 'line-through' : ''}`}>
        {SOAP.filter(([k]) => n[k]).map(([k, label]) => (
          <div key={k}>
            <dt className="inline font-semibold">{label[0]}: </dt>
            <dd className="inline whitespace-pre-wrap">{n[k]}</dd>
          </div>
        ))}
      </dl>
      {n.enteredInError && <p className="mt-1 text-xs text-red-700">Entered in error: {n.enteredInError.reason}</p>}
      {n.addenda.length > 0 && (
        <ul className="mt-2 space-y-1 border-l-2 border-brand-600 pl-3">
          {n.addenda.map((a) => (
            <li key={a.id}>
              <span className="text-xs text-slate-600">
                Addendum · {a.author?.name} · {formatDateTime(a.createdAt)}
              </span>
              <p className="whitespace-pre-wrap">{a.body}</p>
            </li>
          ))}
        </ul>
      )}
      {!n.enteredInError && (
        <Can perm="emr.notes.write">
          <div className="mt-2 flex flex-wrap gap-3">
            {n.status === 'signed' && !adding && (
              <button className="text-xs text-brand-800 hover:underline" onClick={() => setAdding(true)}>
                Add addendum
              </button>
            )}
            {n.status === 'draft' && mine && (
              <button className="text-xs text-brand-800 hover:underline" onClick={() => sign.mutate()}>
                Sign draft
              </button>
            )}
            <button
              className="text-xs text-red-700 hover:underline"
              onClick={() => {
                const reason = window.prompt('Why is this note wrong (e.g. wrong patient)?');
                if (reason) markError.mutate(reason);
              }}
            >
              Entered in error
            </button>
          </div>
          {adding && (
            <form
              className="mt-2 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                addendum.mutate();
              }}
            >
              <label className="block">
                <span className="label">Addendum</span>
                <textarea className="input min-h-16 py-2" value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
              <div className="flex gap-2">
                <button className="btn-primary min-h-8 px-3 text-xs" disabled={body.trim().length < 2}>
                  Add
                </button>
                <button type="button" className="btn-secondary min-h-8 px-3 text-xs" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          <ErrorMessage error={addendum.error || sign.error || markError.error} />
        </Can>
      )}
    </li>
  );
}

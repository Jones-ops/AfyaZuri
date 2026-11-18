import { cloneElement, useId } from 'react';

/** Labelled form field. Pass a single input element as the child; id and ARIA are wired automatically. */
export function Field({ label, error, hint, children, required }) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
        {required && (
          <span className="text-red-700" aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>
      {cloneElement(children, { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className="mt-1 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Ring of eight beads going round. Decorative; pair it with visible or screen-reader text. */
export function DotRing({ size = '2.25rem', className = '' }) {
  return (
    <span className={`dot-ring ${className}`} style={{ '--ring-size': size }} aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

/** A single skeleton bone. Give it a size with className (e.g. "h-4 w-2/3"). */
export function Skeleton({ className = 'h-4 w-full' }) {
  return <span className={`skeleton block ${className}`} aria-hidden />;
}

const LINE_WIDTHS = ['w-11/12', 'w-4/5', 'w-2/3', 'w-5/6', 'w-3/4', 'w-1/2'];

/** Loading state for a section: the dot ring with its label, over skeleton rows shaped like a list. */
export function Spinner({ label = 'Loading…', rows = 3 }) {
  return (
    <div className="p-4" role="status" aria-live="polite">
      <div className="mb-4 flex items-center gap-3 text-sm text-slate-600">
        <DotRing size="1.75rem" />
        <span>{label}</span>
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className={`h-3 ${LINE_WIDTHS[i % LINE_WIDTHS.length]}`} />
              <Skeleton className={`h-3 ${LINE_WIDTHS[(i + 3) % LINE_WIDTHS.length]} opacity-70`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Loading state for a whole page: header and panels as skeletons, with the dot ring in the middle. */
export function PageSkeleton({ label = 'Loading…' }) {
  return (
    <div className="page-in relative" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="mb-6 space-y-2">
        <Skeleton className="h-6 w-56 max-w-full" />
        <Skeleton className="h-3.5 w-80 max-w-full opacity-70" />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="card space-y-3 p-4 md:col-span-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className={`h-3 ${LINE_WIDTHS[i]}`} />
                <Skeleton className={`h-3 ${LINE_WIDTHS[(i + 2) % LINE_WIDTHS.length]} opacity-70`} />
              </div>
            </div>
          ))}
        </div>
        <div className="card space-y-3 p-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2 opacity-70" />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="card flex items-center gap-3 rounded-full px-4 py-2 text-sm text-slate-700">
          <DotRing size="1.75rem" />
          {label}
        </span>
      </div>
    </div>
  );
}

export function Alert({ kind = 'error', children }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return (
    <div
      className={`pop-in rounded-md border px-3 py-2 text-sm shadow-[inset_0_1px_0_rgb(255_255_255/0.6),0_1px_2px_rgb(15_23_42/0.06)] ${styles[kind]}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

/** Show an API error, including field-level validation issues and policy problems. */
export function ErrorMessage({ error }) {
  if (!error) return null;
  const issues = error.details?.issues ?? [];
  const problems = error.details?.problems ?? [];
  return (
    <Alert>
      <p>{error.message}</p>
      {(issues.length > 0 || problems.length > 0) && (
        <ul className="mt-1 list-disc pl-5">
          {issues.map((i) => (
            <li key={i.path + i.message}>
              {i.path && <strong>{i.path}: </strong>}
              {i.message}
            </li>
          ))}
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div className="p-8 text-center">
      <p className="font-medium text-slate-800">{title}</p>
      {children && <p className="mt-1 text-sm text-slate-600">{children}</p>}
    </div>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ tone = 'slate', children }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-800',
    red: 'bg-red-100 text-red-800',
    amber: 'bg-amber-100 text-amber-900',
    blue: 'bg-sky-100 text-sky-800',
    teal: 'bg-brand-100 text-brand-900',
  };
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium shadow-[inset_0_1px_0_rgb(255_255_255/0.6),0_0_0_1px_rgb(15_23_42/0.05)] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export const formatDateTime = (v) =>
  v
    ? new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Nairobi' }).format(
        new Date(v),
      )
    : '—';

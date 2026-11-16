import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { checkPassword } from '@afyazuri/shared';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, ErrorMessage, Field, PageHeader } from '../components/ui.jsx';

export default function Account({ forced = false }) {
  const { me, refresh, signOut } = useAuth();
  return (
    <div className={forced ? 'mx-auto max-w-lg p-4 pt-10' : ''}>
      <PageHeader title={forced ? 'Set a new password' : 'My account'} description={forced ? 'You need to choose a new password before continuing.' : me.user.fullName} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ChangePassword username={me.user.username} onDone={refresh} />
        {!forced && <TwoFactor enabled={me.user.totpEnabled} onDone={refresh} />}
      </div>
      {forced && <button className="btn-secondary mt-4" onClick={signOut}>Sign out</button>}
    </div>
  );
}

function ChangePassword({ username, onDone }) {
  const form = useForm();
  const [ok, setOk] = useState(false);
  const m = useMutation({
    mutationFn: (v) => api.post('/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword }),
    onSuccess: () => { setOk(true); form.reset(); onDone(); },
  });
  const problems = checkPassword(form.watch('newPassword') ?? '', { username });
  return (
    <form className="card space-y-3 p-4" onSubmit={form.handleSubmit((v) => m.mutate(v))}>
      <h2 className="font-semibold">Change password</h2>
      {ok && <Alert kind="success">Password changed. Your other sessions were signed out.</Alert>}
      <ErrorMessage error={m.error} />
      <Field label="Current password"><input className="input" type="password" autoComplete="current-password" {...form.register('currentPassword', { required: true })} /></Field>
      <Field label="New password"><input className="input" type="password" autoComplete="new-password" {...form.register('newPassword', { required: true })} /></Field>
      {form.watch('newPassword') && problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-900">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
      <button className="btn-primary" disabled={m.isPending || problems.length > 0}>Change password</button>
    </form>
  );
}

function TwoFactor({ enabled, onDone }) {
  const [setup, setSetup] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState('');
  const start = useMutation({
    mutationFn: () => api.post('/auth/totp/setup'),
    onSuccess: async (d) => {
      setSetup(d);
      const QR = await import('qrcode'); // loaded only on this screen
      setQr(await QR.toDataURL(d.otpauthUrl, { margin: 1, width: 200 }));
    },
  });
  const confirm = useMutation({ mutationFn: () => api.post(`/auth/totp/${enabled ? 'disable' : 'enable'}`, { code }), onSuccess: () => { setSetup(null); setCode(''); onDone(); } });

  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">Two-factor authentication</h2>
      <p className="text-sm text-slate-600">{enabled ? 'Enabled. You will be asked for a code from your authenticator app at sign-in.' : 'Add a second step at sign-in using an authenticator app.'}</p>
      <ErrorMessage error={start.error || confirm.error} />
      {!enabled && !setup && <button className="btn-secondary" onClick={() => start.mutate()} disabled={start.isPending}>Set up</button>}
      {setup && (
        <div className="space-y-2">
          {qr && <img src={qr} alt="QR code for your authenticator app" width="200" height="200" />}
          <p className="text-xs text-slate-600">Or enter this key manually: <code className="break-all">{setup.secret}</code></p>
        </div>
      )}
      {(setup || enabled) && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); confirm.mutate(); }}>
          <input className="input max-w-40 tracking-widest" inputMode="numeric" maxLength={6} aria-label="6-digit code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className={enabled ? 'btn-danger' : 'btn-primary'} disabled={code.length !== 6}>{enabled ? 'Turn off' : 'Confirm'}</button>
        </form>
      )}
    </section>
  );
}

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { loginBody } from '@afyazuri/shared';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Photo, PhotoCredit, PHOTOS } from '../components/Photo.jsx';
import { Alert, ErrorMessage, Field } from '../components/ui.jsx';

const REASONS = {
  SESSION_IDLE: 'You were signed out after a period of inactivity.',
  SESSION_ENDED: 'Your session ended. Please sign in again.',
  REFRESH_TOKEN_REUSED: 'For your security your session was ended. Please sign in again.',
  ACCOUNT_DISABLED: 'This account has been disabled.',
};

export default function Login() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const [needTotp, setNeedTotp] = useState(false);
  const [reason] = useState(() => {
    try {
      const r = sessionStorage.getItem('az.signedOutReason');
      sessionStorage.removeItem('az.signedOutReason');
      return r;
    } catch {
      return null;
    }
  });
  const form = useForm({ resolver: zodResolver(loginBody), defaultValues: { username: '', password: '' } });
  const login = useMutation({
    mutationFn: (values) => api.post('/auth/login', values),
    onSuccess: () => refresh(),
    onError: (e) => {
      if (e.code === 'MFA_REQUIRED') setNeedTotp(true);
    },
  });

  if (me) return <Navigate to="/" replace />;
  const { errors } = form.formState;

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <HeroPhoto />
      <div className="flex flex-1 items-center justify-center p-4 py-8 lg:p-10">
        <div className="page-in w-full max-w-sm">
          <div className="mb-6 text-center">
            <img
              src="/icon.svg"
              alt=""
              width="56"
              height="56"
              className="mx-auto mb-3 rounded-2xl bg-white p-1.5 shadow-[inset_0_1px_0_#fff,0_2px_4px_rgb(15_23_42/0.12),0_10px_20px_-10px_rgb(15_118_110/0.6)]"
            />
            <h1 className="text-2xl font-semibold text-slate-900">{t('appName')}</h1>
            <p className="text-sm text-slate-600">{t('tagline')}</p>
          </div>
          <form className="card space-y-4 p-6" onSubmit={form.handleSubmit((v) => login.mutate(v))} noValidate>
            {reason && REASONS[reason] && <Alert kind="info">{REASONS[reason]}</Alert>}
            {login.error && login.error.code !== 'MFA_REQUIRED' && <ErrorMessage error={login.error} />}
            <Field label={t('username')} error={errors.username?.message}>
              <input
                className="input"
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                {...form.register('username')}
              />
            </Field>
            <Field label={t('password')} error={errors.password?.message}>
              <input className="input" type="password" autoComplete="current-password" {...form.register('password')} />
            </Field>
            {needTotp && (
              <Field label={t('totpCode')} hint="6 digits from your authenticator app" error={errors.totp?.message}>
                <input
                  className="input tracking-widest"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  {...form.register('totp')}
                />
              </Field>
            )}
            <button type="submit" className="btn-primary w-full" disabled={login.isPending}>
              {login.isPending ? t('signingIn') : t('signIn')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function HeroPhoto() {
  const photo = PHOTOS.wardNurse;
  return (
    <figure className="relative h-56 shrink-0 overflow-hidden bg-brand-900 sm:h-72 lg:h-auto lg:w-[45%] xl:w-1/2">
      <Photo photo={photo} sizes="(min-width: 1024px) 50vw, 100vw" position="50% 25%" priority />
      <div
        className="absolute inset-0 bg-gradient-to-t from-brand-900/85 via-brand-900/25 to-transparent"
        aria-hidden
      />
      <div className="absolute inset-x-0 bottom-0 p-5 text-white lg:p-10">
        <p className="hidden max-w-md text-2xl leading-snug font-semibold [text-shadow:0_1px_3px_rgb(0_0_0/0.4)] lg:block">
          Every department on one system, from the front desk to the ward.
        </p>
        <figcaption className="mt-2 text-[11px] text-white/80 lg:mt-4">
          <PhotoCredit photo={photo} />
        </figcaption>
      </div>
    </figure>
  );
}

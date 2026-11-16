import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { ApiError, api, onSessionEnded } from './api.js';

const AuthContext = createContext(null);

/** Loads the signed-in user's profile and permissions; null when signed out. */
export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });

  useEffect(
    () =>
      onSessionEnded((code) => {
        qc.setQueryData(['me'], null);
        try {
          sessionStorage.setItem('az.signedOutReason', code);
        } catch {
          /* ignore */
        }
      }),
    [qc],
  );

  const value = useMemo(() => {
    const perms = new Set(me.data?.permissions ?? []);
    return {
      me: me.data ?? null,
      loading: me.isPending,
      error: me.error,
      can: (/** @type {string} */ p) => perms.has(p),
      canAny: (/** @type {string[]} */ ps) => ps.some((p) => perms.has(p)),
      refresh: () => qc.invalidateQueries({ queryKey: ['me'] }),
      signOut: async () => {
        await api.post('/auth/logout').catch(() => {});
        qc.clear();
        qc.setQueryData(['me'], null);
      },
    };
  }, [me.data, me.isPending, me.error, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** @returns {{me: any, loading: boolean, error: any, can: (p: string) => boolean, canAny: (p: string[]) => boolean, refresh: () => Promise<void>, signOut: () => Promise<void>}} */
export const useAuth = () => useContext(AuthContext);

/** Render children only when the user holds the permission. The API still enforces it. */
export function Can({ perm, children, fallback = null }) {
  const { can, canAny } = useAuth();
  const ok = Array.isArray(perm) ? canAny(perm) : can(perm);
  return ok ? children : fallback;
}

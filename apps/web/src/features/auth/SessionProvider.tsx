'use client';

import type { PublicUser } from '@apihub/contracts';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { api } from '@/lib/api-client';

export interface SessionState {
  user: PublicUser | null;
  csrfToken: string | null;
}

interface SessionContextValue extends SessionState {
  isAuthenticated: boolean;
  /** Re-read the session from the API, e.g. after signing in elsewhere. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Session context.
 *
 * Seeded from the server render (`initialSession`) so the first paint is
 * already correct — no "signed out" flash for an authenticated user.
 */
export function SessionProvider({
  initialSession,
  children,
}: {
  initialSession: SessionState;
  children: ReactNode;
}) {
  const [session, setSession] = useState<SessionState>(initialSession);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const result = await api.get<SessionState>('/v1/auth/session');
      setSession(result.data);
    } catch {
      setSession({ user: null, csrfToken: null });
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/v1/auth/logout', undefined, {
        csrfToken: session.csrfToken ?? undefined,
      });
    } finally {
      setSession({ user: null, csrfToken: null });
      // Refresh Server Components so personalised data disappears too.
      router.refresh();
      router.push('/');
    }
  }, [router, session.csrfToken]);

  const value = useMemo<SessionContextValue>(
    () => ({
      ...session,
      isAuthenticated: session.user !== null,
      refresh,
      signOut,
    }),
    [session, refresh, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <SessionProvider>');
  return context;
}

import 'server-only';

import type { PublicUser } from '@apihub/contracts';

import { fetchPrivateOrNull } from './server-api';

export interface SessionState {
  user: PublicUser | null;
  csrfToken: string | null;
}

/**
 * Resolve the current session during a server render.
 *
 * Never throws: an expired session or an unreachable API yields the
 * signed-out state, so a public page still renders.
 */
export async function getSession(): Promise<SessionState> {
  const result = await fetchPrivateOrNull<SessionState>('/v1/auth/session');
  return result?.data ?? { user: null, csrfToken: null };
}

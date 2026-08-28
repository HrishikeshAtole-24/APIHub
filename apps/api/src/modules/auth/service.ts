/**
 * Authentication service (report 19).
 *
 * Design decisions
 * ----------------
 *  - Server-side sessions in PostgreSQL, not stateless JWTs. Logout and
 *    "revoke all devices" must take effect immediately, which a self-contained
 *    token cannot offer without a revocation list that reintroduces the lookup
 *    anyway.
 *  - The cookie holds `<sessionId>.<hmac>`. The HMAC lets a forged cookie be
 *    rejected without a database hit; the id is what actually identifies the
 *    session.
 *  - Only the HMAC of the session id is stored, so a database dump does not
 *    yield usable cookies.
 *  - Login is constant-ish time whether or not the account exists, so it
 *    cannot be used to enumerate registered emails.
 */
import { getConfig } from '@apihub/config';
import type { PublicUser } from '@apihub/contracts';
import { schema, type Database } from '@apihub/database';
import { getLogger } from '@apihub/logger';
import { events } from '@apihub/runtime';
import {
  avatarColorFor,
  fakeVerify,
  generateSessionId,
  hashPassword,
  hashSessionId,
  needsRehash,
  signSessionId,
  verifyPassword,
  verifySessionCookie,
} from '@apihub/security';
import { and, eq, gt, lt } from 'drizzle-orm';

import { ConflictError, UnauthorizedError } from '../../shared/errors.js';

const log = getLogger('api.auth');

export interface SessionContext {
  user: PublicUser;
  sessionId: string;
  expiresAt: Date;
}

export function toPublicUser(row: typeof schema.users.$inferSelect): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as PublicUser['role'],
    avatarColor: row.avatarColor,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AuthService {
  constructor(private readonly db: Database) {}

  async register(input: {
    email: string;
    name: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ user: PublicUser; cookie: string; expiresAt: Date }> {
    const email = input.email.trim().toLowerCase();

    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictError('An account with that email already exists.');
    }

    const id = schema.newId('user');
    const passwordHash = await hashPassword(input.password);

    const [created] = await this.db
      .insert(schema.users)
      .values({
        id,
        email,
        name: input.name.trim(),
        passwordHash,
        role: 'user',
        avatarColor: avatarColorFor(id),
      })
      .returning();

    if (!created) throw new Error('Failed to create user');

    log.info({ userId: id }, 'user registered');
    events.emitAsync('user.registered', { userId: id, email });

    const session = await this.createSession(created.id, input.ipAddress, input.userAgent);
    return { user: toPublicUser(created), ...session };
  }

  async login(input: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ user: PublicUser; cookie: string; expiresAt: Date }> {
    const email = input.email.trim().toLowerCase();

    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    // No account: still perform a hash verification so the response time does
    // not reveal whether the email is registered.
    if (!user || !user.passwordHash) {
      await fakeVerify(input.password);
      throw new UnauthorizedError('Incorrect email or password.');
    }

    if (user.deactivatedAt) {
      await fakeVerify(input.password);
      throw new UnauthorizedError('This account has been deactivated.');
    }

    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedError('Incorrect email or password.');
    }

    // Transparently upgrade hashes created with weaker parameters.
    if (needsRehash(user.passwordHash)) {
      const upgraded = await hashPassword(input.password);
      await this.db
        .update(schema.users)
        .set({ passwordHash: upgraded, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      log.info({ userId: user.id }, 'password hash upgraded');
    }

    await this.db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, user.id));

    const session = await this.createSession(user.id, input.ipAddress, input.userAgent);
    return { user: toPublicUser(user), ...session };
  }

  /** Create a session row and return the signed cookie value. */
  async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ cookie: string; expiresAt: Date }> {
    const config = getConfig();

    const sessionId = generateSessionId();
    const storedId = hashSessionId(sessionId, config.AUTH_SECRET);
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_SECONDS * 1000);

    await this.db.insert(schema.sessions).values({
      id: storedId,
      userId,
      expiresAt,
      // Truncate the UA: enough to recognise a device, not enough to fingerprint.
      userAgent: userAgent?.slice(0, 200) ?? null,
      ipAddress: ipAddress ?? null,
    });

    return { cookie: signSessionId(sessionId, config.AUTH_SECRET), expiresAt };
  }

  /**
   * Resolve a cookie value into a session, or null.
   *
   * Returning null (rather than throwing) is deliberate: most endpoints treat
   * "no valid session" as anonymous rather than as an error.
   */
  async resolveSession(cookieValue: string | undefined): Promise<SessionContext | null> {
    if (!cookieValue) return null;

    const config = getConfig();
    const sessionId = verifySessionCookie(cookieValue, config.AUTH_SECRET);
    if (!sessionId) return null;

    const storedId = hashSessionId(sessionId, config.AUTH_SECRET);

    const [row] = await this.db
      .select({ session: schema.sessions, user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .where(and(eq(schema.sessions.id, storedId), gt(schema.sessions.expiresAt, new Date())))
      .limit(1);

    if (!row || row.user.deactivatedAt) return null;

    // Refresh lastSeenAt at most once a minute; writing on every request would
    // turn a read-only endpoint into a write on the hot path.
    const staleBy = Date.now() - row.session.lastSeenAt.getTime();
    if (staleBy > 60_000) {
      void this.db
        .update(schema.sessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.sessions.id, storedId))
        .catch(() => {});
    }

    return {
      user: toPublicUser(row.user),
      sessionId,
      expiresAt: row.session.expiresAt,
    };
  }

  async logout(cookieValue: string | undefined): Promise<void> {
    if (!cookieValue) return;

    const config = getConfig();
    const sessionId = verifySessionCookie(cookieValue, config.AUTH_SECRET);
    if (!sessionId) return;

    await this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, hashSessionId(sessionId, config.AUTH_SECRET)));
  }

  /** Revoke every session for a user, e.g. after a password change. */
  async logoutAll(userId: string): Promise<number> {
    const deleted = await this.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .returning({ id: schema.sessions.id });
    return deleted.length;
  }

  /** Delete expired sessions. Called by the maintenance job. */
  async purgeExpiredSessions(): Promise<number> {
    const deleted = await this.db
      .delete(schema.sessions)
      .where(lt(schema.sessions.expiresAt, new Date()))
      .returning({ id: schema.sessions.id });
    return deleted.length;
  }
}

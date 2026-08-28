/**
 * Password hashing with Argon2id (report 19: "Hash passwords with Argon2id").
 *
 * Implementation choice
 * ---------------------
 * `hash-wasm` provides Argon2id compiled to WebAssembly. Compared with a native
 * binding it needs no compiler toolchain, works identically across Windows,
 * macOS, Linux and Alpine containers, and cannot break a `pnpm install` on a
 * machine without build tools. The cost is roughly 2-3x slower hashing, which
 * is irrelevant at login volumes and is absorbed by tuning the parameters.
 *
 * Parameters follow OWASP's Argon2id guidance: 19 MiB memory, 2 iterations,
 * parallelism 1. Memory cost is what actually defeats GPU cracking.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { argon2id, argon2Verify } from 'hash-wasm';

const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19_456, // KiB (19 MiB)
  hashLength: 32,
  outputType: 'encoded' as const,
};

const SALT_BYTES = 16;

/**
 * Hash a password. Returns a self-describing PHC string
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) so parameters can be
 * upgraded later without a migration.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error('Password must not be empty');

  return argon2id({
    password,
    salt: randomBytes(SALT_BYTES),
    ...ARGON2_PARAMS,
  });
}

/**
 * Verify a password against a stored hash.
 *
 * Never throws on a malformed stored hash: a corrupt record must read as
 * "wrong password", not as a 500 that reveals the record exists.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('$argon2')) return false;
  try {
    return await argon2Verify({ password, hash: storedHash });
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than we now use,
 * so it can be transparently upgraded on the user's next successful login.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;

  const [, memory, iterations, parallelism] = match;
  return (
    Number(memory) < ARGON2_PARAMS.memorySize ||
    Number(iterations) < ARGON2_PARAMS.iterations ||
    Number(parallelism) < ARGON2_PARAMS.parallelism
  );
}

/**
 * Constant-time string comparison. Used for session tokens and CSRF tokens,
 * where `===` would leak length and prefix information through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  // timingSafeEqual throws on length mismatch, which itself leaks length.
  // Hash both to a fixed width first so the comparison is always same-length.
  if (bufferA.length !== bufferB.length) {
    // Still perform a comparison to keep the timing profile flat.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * A dummy verification used when no user matches the submitted email.
 *
 * Without it, "unknown email" returns in ~1 ms while "known email, wrong
 * password" takes ~50 ms, which turns login into a user-enumeration oracle.
 *
 * The decoy hash is computed for real, once, on first use. A hand-written
 * constant would be rejected as malformed and return immediately, which would
 * defeat the entire point of this function.
 */
let decoyHash: Promise<string> | null = null;

function getDecoyHash(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(24).toString('hex'));
  return decoyHash;
}

/** Warm the decoy hash at boot so the first failed login is not anomalously slow. */
export async function warmPasswordHasher(): Promise<void> {
  await getDecoyHash();
}

export async function fakeVerify(password: string): Promise<false> {
  await verifyPassword(password, await getDecoyHash());
  return false;
}

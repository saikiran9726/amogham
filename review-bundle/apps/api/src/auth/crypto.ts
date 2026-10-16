import crypto from 'node:crypto';
import * as argon2 from '@node-rs/argon2';

// Argon2id parameters optimized for security and shared-device performance
const ARGON2_OPTIONS: argon2.Options = {
  algorithm: 2 as argon2.Algorithm.Argon2id, // Argon2id
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(public readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.current--;
        const next = this.queue.shift();
        if (next) {
          this.current++;
          next();
        }
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.current--;
          const next = this.queue.shift();
          if (next) {
            this.current++;
            next();
          }
        });
      });
    });
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get activeCount(): number {
    return this.current;
  }

  get queuedCount(): number {
    return this.queue.length;
  }
}

const ARGON2_CONCURRENCY = process.env.ARGON2_CONCURRENCY
  ? parseInt(process.env.ARGON2_CONCURRENCY, 10)
  : 4;
export const argon2Semaphore = new Semaphore(ARGON2_CONCURRENCY);

/**
 * Hashes a password using Argon2id with semaphore protection against threadpool starvation.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2Semaphore.runExclusive(() => argon2.hash(password, ARGON2_OPTIONS));
}

/**
 * Verifies a password against an Argon2id hash using constant-time comparison with semaphore protection.
 */
export async function verifyPassword({
  hash,
  secret,
}: {
  hash: string;
  secret: string;
}): Promise<boolean> {
  return argon2Semaphore.runExclusive(async () => {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  });
}

/**
 * Hashes a 4-6 digit numeric PIN using Argon2id with semaphore protection.
 */
export async function hashPin(pin: string): Promise<string> {
  return argon2Semaphore.runExclusive(() => argon2.hash(pin, ARGON2_OPTIONS));
}

/**
 * Verifies a PIN against an Argon2id hash with semaphore protection.
 */
export async function verifyPin({
  hash,
  secret,
}: {
  hash: string;
  secret: string;
}): Promise<boolean> {
  return argon2Semaphore.runExclusive(async () => {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  });
}

/**
 * Pre-computed or lazily-computed Argon2id hash for constant-time dummy verification.
 * Prevents user enumeration via response timing differences.
 */
let dummyHashPromise: Promise<string> | null = null;
export async function getDummyArgon2Hash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('dummy_credential_constant_time_comparison_hash_2026');
  }
  return dummyHashPromise;
}

export async function verifyDummyCredential(secret: string): Promise<boolean> {
  const dummyHash = await getDummyArgon2Hash();
  return verifyPassword({ hash: dummyHash, secret });
}

/**
 * SHA-256 hash for secure storage and lookup of refresh tokens.
 */
export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Generates a cryptographically secure random token string.
 */
export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

import { env } from '../config/env.js';
import { hashPassword } from '../auth/crypto.js';
import { pool } from './client.js';

const OWNER_USERNAME = 'owner';
const OWNER_ROLE = 'OWNER';
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 1024;

function readHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('This utility requires an interactive terminal.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      const input = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const character of input) {
        if (character === '\u0003') {
          finish(new Error('Password entry was cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  if (env.NODE_ENV !== 'development') {
    throw new Error('This utility only runs when NODE_ENV is development.');
  }
  if (process.argv.length > 2) {
    throw new Error('Do not pass credentials or other arguments to this utility.');
  }

  const password = await readHidden('New password (input hidden): ');
  const confirmation = await readHidden('Confirm new password (input hidden): ');
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
  if (password !== confirmation) {
    throw new Error('The passwords did not match. No database changes were made.');
  }

  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const ownerResult = await client.query<{ id: string; role_id: string }>(
      `SELECT u.id, u.role_id
       FROM users AS u
       INNER JOIN roles AS r ON r.id = u.role_id
       WHERE u.username = $1 AND u.active = TRUE AND r.name = $2
       FOR UPDATE OF u`,
      [OWNER_USERNAME, OWNER_ROLE],
    );

    if (ownerResult.rowCount !== 1) {
      throw new Error('Expected exactly one active owner account. No database changes were made.');
    }

    const owner = ownerResult.rows[0]!;
    const updated = await client.query(
      `UPDATE users
       SET password_hash = $1, failed_attempts = 0, locked_until = NULL, updated_at = NOW()
       WHERE id = $2 AND username = $3 AND role_id = $4 AND active = TRUE`,
      [passwordHash, owner.id, OWNER_USERNAME, owner.role_id],
    );
    if (updated.rowCount !== 1) {
      throw new Error('The owner account changed during recovery. No database changes were made.');
    }

    const revoked = await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [owner.id],
    );

    await client.query('COMMIT');
    transactionOpen = false;
    process.stdout.write(
      `Password updated for the existing ${OWNER_ROLE} account '${OWNER_USERNAME}'. ` +
        `Failed-login lockout cleared; ${revoked.rowCount ?? 0} active refresh session(s) revoked.\n`,
    );
  } catch {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw new Error(
      'Password recovery failed; the transaction was rolled back. No changes were committed.',
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Password recovery failed.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

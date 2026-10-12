import { AppError } from '@restaurant-os/shared';
import { verifyAccessToken, type DecodedAccessToken } from './jwt.js';
import { getUserSession } from './token-cache.js';

export type VerifiedIdentity = DecodedAccessToken;

/**
 * Central identity verification function.
 * Validates access tokens across REST authentication and Socket.IO handshakes.
 * Checks token_version and active status against tenant-keyed cache (10s TTL).
 */
export async function verifyUserIdentity(token: string): Promise<VerifiedIdentity> {
  const decoded = verifyAccessToken(token);

  const session = await getUserSession(decoded.restaurantId, decoded.userId);
  if (!session) {
    throw AppError.unauthorized('User not found or session terminated');
  }

  if (decoded.tv !== session.tokenVersion) {
    throw AppError.unauthorized('Token version mismatch: session has been revoked');
  }

  if (!session.active) {
    throw AppError.unauthorized('User account is inactive');
  }

  return decoded;
}

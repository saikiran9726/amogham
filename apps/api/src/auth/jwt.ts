import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';

export const JWT_ISSUER = 'restaurant-os';
export const JWT_AUDIENCE = 'restaurant-os-api';

export interface AccessTokenPayload {
  userId: string;
  restaurantId: string;
  username: string;
  name: string;
  role: string;
  permissions: string[];
  tv?: number;
}

export interface DecodedAccessToken extends AccessTokenPayload {
  tv: number;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string;
}

/**
 * Signs a short-lived access token (default 15 minutes).
 */
export function signAccessToken(
  payload: AccessTokenPayload,
  options?: { expiresIn?: string | number },
): string {
  const tokenPayload = {
    ...payload,
    tv: payload.tv ?? 0,
  };
  return jwt.sign(tokenPayload, env.JWT_SECRET, {
    expiresIn: (options?.expiresIn ?? '15m') as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

/**
 * Verifies and decodes an access token with HS256 algorithm and strict issuer/audience verification.
 * Supports zero-downtime key rotation via JWT_SECRET_PREVIOUS.
 */
export function verifyAccessToken(token: string): DecodedAccessToken {
  const verifyWithSecret = (secret: string): DecodedAccessToken => {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as DecodedAccessToken;

    if (typeof decoded.tv !== 'number') {
      decoded.tv = 0;
    }
    return decoded;
  };

  try {
    return verifyWithSecret(env.JWT_SECRET);
  } catch (err: unknown) {
    if (env.JWT_SECRET_PREVIOUS) {
      try {
        return verifyWithSecret(env.JWT_SECRET_PREVIOUS);
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

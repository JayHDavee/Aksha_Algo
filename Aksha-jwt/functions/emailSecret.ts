import { createHmac, timingSafeEqual } from 'crypto';

import { JWT_SECRET } from "../middleware/validateJWT";

export function generateEmailSecret(email: string, scopes: string[]): string {
  return createHmac('sha256', JWT_SECRET).update(email + scopes.join("")).digest('hex');
}

export function validateEmailSecret(email: string, scopes: string[], providedKey: string): boolean {
  const expectedKey = generateEmailSecret(email, scopes);
  return timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey));
}
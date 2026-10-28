import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Случайный непрозрачный токен (сессия, подтверждение email): 32 байта = 256 бит. */
export const newToken = (): string => randomBytes(32).toString('base64url');

const API_KEY_RE = /^gr_[A-Za-z0-9_-]{43}$/;
export const isApiKeyFormat = (value: string): boolean => API_KEY_RE.test(value);

/** Ключ "gr_" + 32 байта base64url. В БД идут только SHA-256 и первые 8 символов для опознания в списке. */
export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const key = `gr_${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 8), hash: sha256(key) };
}

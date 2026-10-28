import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiKey, isApiKeyFormat, newToken, sha256 } from '../../src/auth/tokens';

describe('generateApiKey', () => {
  it('формат gr_ + 43 символа base64url (32 байта)', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^gr_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(46);
    expect(Buffer.from(key.slice(3), 'base64url')).toHaveLength(32);
  });

  it('префикс — первые 8 символов, в БД идёт SHA-256 всего ключа', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(prefix).toBe(key.slice(0, 8));
    expect(prefix.startsWith('gr_')).toBe(true);
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash('sha256').update(key).digest())).toBe(true);
  });

  it('ключи не повторяются', () => {
    const keys = new Set(Array.from({ length: 2000 }, () => generateApiKey().key));
    expect(keys.size).toBe(2000);
  });
});

describe('isApiKeyFormat', () => {
  it('принимает только gr_ и ровно 43 допустимых символа', () => {
    expect(isApiKeyFormat(generateApiKey().key)).toBe(true);
    expect(isApiKeyFormat('gr_' + 'A'.repeat(43))).toBe(true);
    expect(isApiKeyFormat('gr_' + 'A'.repeat(42))).toBe(false);
    expect(isApiKeyFormat('gr_' + 'A'.repeat(44))).toBe(false);
    expect(isApiKeyFormat('xx_' + 'A'.repeat(43))).toBe(false);
    expect(isApiKeyFormat('gr_' + 'A'.repeat(42) + '+')).toBe(false);
    expect(isApiKeyFormat('gr_' + 'A'.repeat(42) + '=')).toBe(false);
    expect(isApiKeyFormat('')).toBe(false);
    expect(isApiKeyFormat(`gr_${'A'.repeat(43)}\n`)).toBe(false);
  });
});

describe('newToken / sha256', () => {
  it('токен — 32 случайных байта в base64url', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
  });

  it('sha256 детерминирован и возвращает 32 байта', () => {
    expect(sha256('abc').toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abc').equals(sha256('abc'))).toBe(true);
    expect(sha256('abc').equals(sha256('abd'))).toBe(false);
  });
});

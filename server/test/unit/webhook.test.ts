import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../../src/webhook';

const SECRET = 'test-webhook-secret-0123456789';
const BODY = JSON.stringify({ paymentId: 'demo_1', status: 'succeeded', amount: '500.00' });

describe('signPayload', () => {
  it('HMAC-SHA256 в hex: проверка по известному тестовому вектору', () => {
    expect(signPayload('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('строка и Buffer с теми же байтами дают одну подпись', () => {
    expect(signPayload(SECRET, BODY)).toBe(signPayload(SECRET, Buffer.from(BODY)));
    expect(signPayload(SECRET, BODY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('другой секрет или другое тело — другая подпись', () => {
    expect(signPayload('another-secret-0123456789', BODY)).not.toBe(signPayload(SECRET, BODY));
    expect(signPayload(SECRET, BODY + ' ')).not.toBe(signPayload(SECRET, BODY));
  });
});

describe('verifySignature', () => {
  const good = signPayload(SECRET, BODY);

  it('принимает верную подпись', () => {
    expect(verifySignature(SECRET, BODY, good)).toBe(true);
    expect(verifySignature(SECRET, Buffer.from(BODY), good)).toBe(true);
  });

  it('регистр hex и пробелы вокруг не важны', () => {
    expect(verifySignature(SECRET, BODY, good.toUpperCase())).toBe(true);
    expect(verifySignature(SECRET, BODY, ` ${good}\n`)).toBe(true);
  });

  it('отвергает подпись от другого тела, другого секрета, пустую и отсутствующую', () => {
    expect(verifySignature(SECRET, BODY.replace('500.00', '5000.00'), good)).toBe(false);
    expect(verifySignature('another-secret-0123456789', BODY, good)).toBe(false);
    expect(verifySignature(SECRET, BODY, '')).toBe(false);
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false);
  });

  it('подпись другой длины отвергается без исключения (timingSafeEqual иначе бросил бы)', () => {
    expect(verifySignature(SECRET, BODY, good.slice(0, 63))).toBe(false);
    expect(verifySignature(SECRET, BODY, good + '0')).toBe(false);
    expect(verifySignature(SECRET, BODY, 'zz')).toBe(false);
  });

  it('один изменённый символ — отказ', () => {
    const tampered = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    expect(verifySignature(SECRET, BODY, tampered)).toBe(false);
  });
});

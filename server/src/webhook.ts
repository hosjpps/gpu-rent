import { createHmac, timingSafeEqual } from 'node:crypto';

/** Подпись уведомления платёжного шлюза: HMAC-SHA256 от сырого тела, hex в нижнем регистре. */
export function signPayload(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Сравнение за постоянное время; подпись другой длины отвергается до сравнения (timingSafeEqual иначе бросил бы). */
export function verifySignature(secret: string, rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signPayload(secret, rawBody), 'utf8');
  const given = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

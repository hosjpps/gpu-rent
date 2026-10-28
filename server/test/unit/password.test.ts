import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password';

describe('пароли (bcrypt)', () => {
  it('хэш не содержит пароль, имеет формат bcrypt и стоимость из аргумента', async () => {
    const h = await hashPassword('correct horse battery', 4);
    expect(h).toMatch(/^\$2[aby]\$04\$.{53}$/);
    expect(h).not.toContain('correct');
  });

  it('один пароль — разные хэши (соль), но оба подходят', async () => {
    const a = await hashPassword('same-password', 4);
    const b = await hashPassword('same-password', 4);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('неверный пароль отвергается, регистр важен', async () => {
    const h = await hashPassword('Secret-Pass-1', 4);
    expect(await verifyPassword('Secret-Pass-2', h)).toBe(false);
    expect(await verifyPassword('secret-pass-1', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('нет хэша (пользователя не существует) — всегда отказ, но сравнение всё равно выполняется', async () => {
    expect(await verifyPassword('anything-at-all', undefined)).toBe(false);
  });

  it('сравнение с заглушкой занимает время bcrypt, а не мгновенно (выравнивание времени входа)', async () => {
    const t0 = process.hrtime.bigint();
    await verifyPassword('anything-at-all', undefined);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeGreaterThan(20); // заглушка имеет cost 12
  });

  it('пароль с кириллицей хэшируется и проверяется по байтам UTF-8', async () => {
    const h = await hashPassword('Пароль-с-кириллицей', 4);
    expect(await verifyPassword('Пароль-с-кириллицей', h)).toBe(true);
  });
});

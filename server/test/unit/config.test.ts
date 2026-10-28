import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  ENC_KEY: 'enc-key-0123456789abcdef',
  WEBHOOK_SECRET: 'webhook-secret-0123456789',
};

describe('loadConfig', () => {
  it('значения по умолчанию безопасны', () => {
    const c = loadConfig(base);
    expect(c.nodeEnv).toBe('development');
    expect(c.isProd).toBe(false);
    expect(c.bcryptCost).toBe(12);
    expect(c.poolMax).toBe(2);
    expect(c.demoMail).toBe(false);
    expect(c.demoPayments).toBe(false);
    expect(c.cronSecret).toBeUndefined();
    expect(c.cookieSecure).toBe(false);
    expect(c.cookieName).toBe('sid');
    expect(c.sessionTtlSeconds).toBe(7 * 24 * 3600);
    expect(c.trustProxy).toBe(false);
    expect(c.limits.loginEmail).toEqual({ max: 10, windowSeconds: 900 });
    expect(c.limits.registerIp).toEqual({ max: 10, windowSeconds: 3600 });
  });

  it('в production cookie Secure с префиксом __Host-', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(c.isProd).toBe(true);
    expect(c.cookieSecure).toBe(true);
    expect(c.cookieName).toBe('__Host-sid');
  });

  it('обязательные переменные: без DATABASE_URL, с коротким ENC_KEY или WEBHOOK_SECRET — понятная ошибка', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, ENC_KEY: 'short' })).toThrow(/ENC_KEY/);
    expect(() => loadConfig({ ...base, WEBHOOK_SECRET: 'short' })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, CRON_SECRET: 'short' })).toThrow(/CRON_SECRET/);
    expect(() => loadConfig({})).toThrow(/Неверная конфигурация окружения/);
  });

  it('ошибка не содержит значения секретов', () => {
    try {
      loadConfig({ ...base, ENC_KEY: 'secret-1' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-1');
    }
  });

  it('флаги принимают 1/true/yes/on в любом регистре', () => {
    for (const v of ['1', 'true', 'YES', 'On']) expect(loadConfig({ ...base, DEMO_MAIL: v }).demoMail).toBe(true);
    for (const v of ['0', 'false', 'no', 'off', 'x']) expect(loadConfig({ ...base, DEMO_MAIL: v }).demoMail).toBe(false);
  });

  it('целочисленные настройки: нуль, дробь и текст отвергаются', () => {
    expect(loadConfig({ ...base, BCRYPT_COST: '4' }).bcryptCost).toBe(4);
    for (const bad of ['0', '-1', '1.5', 'abc']) expect(() => loadConfig({ ...base, BCRYPT_COST: bad })).toThrow(/BCRYPT_COST/);
  });

  it('разрешённые Origin и адрес сайта нормализуются (без слэша на конце)', () => {
    const c = loadConfig({ ...base, APP_URL: 'https://gpu-rent.vercel.app/', ALLOWED_ORIGINS: ' https://a.example/ , ,https://b.example ' });
    expect(c.appUrl).toBe('https://gpu-rent.vercel.app');
    expect(c.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(() => loadConfig({ ...base, APP_URL: 'not a url' })).toThrow(/APP_URL/);
  });

  it('на Vercel доверяется одному прокси, версия берётся из коммита', () => {
    const c = loadConfig({ ...base, VERCEL: '1', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890' });
    expect(c.trustProxy).toBe(1);
    expect(c.version).toBe('abcdef1');
    expect(loadConfig(base).version).toBe('1.0.0');
  });

  it('лимиты частоты настраиваются через окружение', () => {
    const c = loadConfig({ ...base, AUTH_LOGIN_EMAIL_MAX: '3', AUTH_LOGIN_IP_MAX: '5', AUTH_REGISTER_IP_MAX: '2' });
    expect(c.limits.loginEmail.max).toBe(3);
    expect(c.limits.loginIp.max).toBe(5);
    expect(c.limits.registerIp.max).toBe(2);
  });
});

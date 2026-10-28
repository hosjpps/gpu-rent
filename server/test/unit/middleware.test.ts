import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { csrfGuard, readCookie, requireUser, toAuthUser } from '../../src/auth/middleware';
import { loadConfig } from '../../src/config';
import { AppError } from '../../src/errors';
import { iso, requireAdmin, requireSession } from '../../src/http';
import type { AuthUser } from '../../src/http';

const config = loadConfig({
  DATABASE_URL: 'postgres://u:p@localhost/db',
  ENC_KEY: 'enc-key-0123456789abcdef',
  WEBHOOK_SECRET: 'webhook-secret-0123456789',
  APP_URL: 'https://gpu-rent.example',
  ALLOWED_ORIGINS: 'https://preview.example/',
});

function fakeReq(init: { method?: string; path?: string; headers?: Record<string, string> }): Request {
  return { method: init.method ?? 'POST', path: init.path ?? '/api/instances', headers: init.headers ?? {} } as unknown as Request;
}

/** Прогоняет middleware и возвращает то, что оно передало в next(): ошибку или undefined. */
function run(mw: (req: Request, res: Response, next: NextFunction) => void, req: Request): AppError | undefined {
  let result: unknown = 'не вызвано';
  mw(req, {} as Response, (e?: unknown) => {
    result = e;
  });
  expect(result).not.toBe('не вызвано');
  return result as AppError | undefined;
}

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 1, email: 'a@b.cc', fullName: 'A', role: 'client', status: 'active', balance: '0.0000', emailVerified: true, ...over,
});

describe('csrfGuard', () => {
  const guard = csrfGuard(config);
  const good = { 'x-requested-with': 'fetch', origin: 'https://gpu-rent.example', host: 'gpu-rent.example' };

  it('безопасные методы пропускаются без заголовков', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(run(guard, fakeReq({ method }))).toBeUndefined();
  });

  it('небезопасный метод без X-Requested-With — 403 CSRF', () => {
    const e = run(guard, fakeReq({ headers: { origin: good.origin } }));
    expect(e?.status).toBe(403);
    expect(e?.code).toBe('CSRF');
  });

  it('X-Requested-With с другим значением не подходит', () => {
    expect(run(guard, fakeReq({ headers: { ...good, 'x-requested-with': 'XMLHttpRequest' } }))?.code).toBe('CSRF');
  });

  it('без Origin или с чужим Origin — 403 CSRF', () => {
    expect(run(guard, fakeReq({ headers: { 'x-requested-with': 'fetch' } }))?.code).toBe('CSRF');
    expect(run(guard, fakeReq({ headers: { ...good, origin: 'https://evil.example' } }))?.code).toBe('CSRF');
    expect(run(guard, fakeReq({ headers: { ...good, origin: 'null' } }))?.code).toBe('CSRF');
    expect(run(guard, fakeReq({ headers: { ...good, origin: 'https://gpu-rent.example.evil.com' } }))?.code).toBe('CSRF');
  });

  it('Origin своего сайта, из ALLOWED_ORIGINS и совпадающий с Host пропускаются', () => {
    expect(run(guard, fakeReq({ headers: good }))).toBeUndefined();
    expect(run(guard, fakeReq({ headers: { ...good, origin: 'https://preview.example' } }))).toBeUndefined();
    expect(run(guard, fakeReq({ headers: { ...good, origin: 'http://localhost:5173', host: 'localhost:5173' } }))).toBeUndefined();
    expect(run(guard, fakeReq({ headers: { ...good, origin: 'https://gpu-rent.example/' } }))).toBeUndefined();
  });

  it('Bearer, вебхук и cron исключены', () => {
    expect(run(guard, fakeReq({ headers: { authorization: 'Bearer gr_x' } }))).toBeUndefined();
    expect(run(guard, fakeReq({ path: '/api/webhooks/payments' }))).toBeUndefined();
    expect(run(guard, fakeReq({ path: '/api/internal/billing' }))).toBeUndefined();
  });

  it('Authorization не-Bearer (Basic) исключением не является', () => {
    expect(run(guard, fakeReq({ headers: { authorization: 'Basic abc' } }))?.code).toBe('CSRF');
  });

  it('вход и регистрация тоже защищены (login-CSRF)', () => {
    expect(run(guard, fakeReq({ path: '/api/auth/login' }))?.code).toBe('CSRF');
    expect(run(guard, fakeReq({ path: '/api/auth/register' }))?.code).toBe('CSRF');
  });

  it('путь, лишь похожий на исключение, исключением не является', () => {
    expect(run(guard, fakeReq({ path: '/api/instances/webhooks/' }))?.code).toBe('CSRF');
    expect(run(guard, fakeReq({ path: '/api/webhooks' }))?.code).toBe('CSRF');
  });
});

describe('readCookie', () => {
  it('находит cookie по точному имени среди нескольких', () => {
    const req = { headers: { cookie: 'a=1; sid=token123; b=2' } } as unknown as Request;
    expect(readCookie(req, 'sid')).toBe('token123');
    expect(readCookie(req, 'a')).toBe('1');
  });

  it('не путает имя с похожим и не находит отсутствующее', () => {
    const req = { headers: { cookie: 'xsid=bad; sid2=bad; mysid=bad' } } as unknown as Request;
    expect(readCookie(req, 'sid')).toBeUndefined();
    expect(readCookie({ headers: {} } as unknown as Request, 'sid')).toBeUndefined();
  });

  it('битое %-кодирование в значении — как отсутствие cookie, а не исключение', () => {
    for (const value of ['%', '%E0%A4%A', '%zz', 'abc%']) {
      expect(readCookie({ headers: { cookie: `sid=${value}` } } as unknown as Request, 'sid')).toBeUndefined();
    }
  });

  it('декодирует значение', () => {
    expect(readCookie({ headers: { cookie: 'sid=a%20b' } } as unknown as Request, 'sid')).toBe('a b');
  });
});

describe('проверки доступа', () => {
  it('requireUser: нет пользователя — 401, заблокирован — 403 USER_BLOCKED, активный проходит', () => {
    expect(run(requireUser, { } as Request)?.status).toBe(401);
    const blocked = run(requireUser, { user: user({ status: 'blocked' }) } as Request);
    expect(blocked?.status).toBe(403);
    expect(blocked?.code).toBe('USER_BLOCKED');
    expect(run(requireUser, { user: user() } as Request)).toBeUndefined();
  });

  it('requireAdmin: клиент — 403, аноним — 401, администратор проходит', () => {
    expect(run(requireAdmin, {} as Request)?.status).toBe(401);
    expect(run(requireAdmin, { user: user() } as Request)?.status).toBe(403);
    expect(run(requireAdmin, { user: user({ role: 'admin' }) } as Request)).toBeUndefined();
  });

  it('requireSession: API-ключ — 403 SESSION_REQUIRED, cookie проходит', () => {
    const viaKey = run(requireSession, { user: user(), authVia: 'apikey' } as Request);
    expect(viaKey?.status).toBe(403);
    expect(viaKey?.code).toBe('SESSION_REQUIRED');
    expect(run(requireSession, { user: user(), authVia: 'cookie' } as Request)).toBeUndefined();
    expect(run(requireSession, {} as Request)?.status).toBe(401);
  });
});

describe('вспомогательные функции', () => {
  it('toAuthUser переводит строку БД в пользователя', () => {
    const u = toAuthUser({
      o_user_id: 5, o_email: 'x@y.zz', o_full_name: 'Имя', o_role: 'client', o_status: 'active', o_balance: '10.0000', o_email_verified_at: new Date(),
    });
    expect(u).toEqual({ id: 5, email: 'x@y.zz', fullName: 'Имя', role: 'client', status: 'active', balance: '10.0000', emailVerified: true });
    expect(toAuthUser({ o_user_id: 5, o_email: 'x', o_full_name: 'n', o_role: 'admin', o_status: 'blocked', o_balance: '0', o_email_verified_at: null }).emailVerified).toBe(false);
  });

  it('iso: дата в ISO 8601, пустое значение — null', () => {
    expect(iso(new Date('2026-10-28T12:00:00.000Z'))).toBe('2026-10-28T12:00:00.000Z');
    expect(iso(null)).toBeNull();
    expect(iso(undefined)).toBeNull();
  });
});

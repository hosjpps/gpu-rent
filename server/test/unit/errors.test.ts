import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, mapDbError, sqlState, tooManyRequests, toAppError, zodDetails } from '../../src/errors';

const dbError = (code: string) => Object.assign(new Error('внутренний текст PostgreSQL: relation "users" violates something'), { code });

describe('маппинг ошибок БД (SQLSTATE -> HTTP)', () => {
  it.each([
    ['GR001', 409, 'NO_CAPACITY'],
    ['GR002', 402, 'INSUFFICIENT_FUNDS'],
    ['GR003', 409, 'INVALID_STATE'],
    ['GR004', 404, 'NOT_FOUND'],
    ['GR005', 422, 'CONSISTENCY'],
    ['GR006', 500, 'CONFIG'],
    ['23505', 409, 'CONFLICT'],
    ['23503', 422, 'VALIDATION'],
    ['23514', 422, 'VALIDATION'],
    ['23P01', 409, 'CONFLICT'],
    ['23001', 409, 'INVALID_STATE'],
    ['40001', 409, 'CONFLICT'],
    ['40P01', 409, 'CONFLICT'],
    ['42501', 403, 'FORBIDDEN'],
    ['57014', 503, 'TIMEOUT'],
    ['55P03', 503, 'TIMEOUT'],
  ])('%s -> %i %s', (state, status, code) => {
    const e = mapDbError(dbError(state));
    expect(e).toBeInstanceOf(AppError);
    expect(e?.status).toBe(status);
    expect(e?.code).toBe(code);
  });

  it('текст ошибки PostgreSQL клиенту не отдаётся', () => {
    for (const state of ['GR001', '23505', '42501', '23503']) {
      const e = mapDbError(dbError(state))!;
      expect(e.message).not.toMatch(/relation|users|violates|PostgreSQL/);
      expect(e.message).toMatch(/[А-Яа-я]/); // сообщения по-русски
    }
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03', '53300', '08006', '08001'])('%s -> 503 DB_UNAVAILABLE', (state) => {
    const e = mapDbError(dbError(state));
    expect(e?.status).toBe(503);
    expect(e?.code).toBe('DB_UNAVAILABLE');
  });

  it('таймаут получения соединения из пула (ошибка без кода) -> 503', () => {
    expect(mapDbError(new Error('timeout exceeded when trying to connect'))?.status).toBe(503);
    expect(mapDbError(new Error('Connection terminated unexpectedly'))?.code).toBe('DB_UNAVAILABLE');
  });

  it('неизвестный код и обычные ошибки не мапятся', () => {
    expect(mapDbError(dbError('99999'))).toBeNull();
    expect(mapDbError(new Error('что-то'))).toBeNull();
    expect(mapDbError('строка')).toBeNull();
    expect(mapDbError(null)).toBeNull();
  });

  it('sqlState достаёт код только из строки', () => {
    expect(sqlState(dbError('GR002'))).toBe('GR002');
    expect(sqlState({ code: 42 })).toBeUndefined();
    expect(sqlState(new Error('x'))).toBeUndefined();
    expect(sqlState(undefined)).toBeUndefined();
  });
});

describe('toAppError', () => {
  it('AppError проходит как есть', () => {
    const e = new AppError(418, 'TEAPOT', 'я чайник');
    expect(toAppError(e)).toBe(e);
  });

  it('ZodError -> 400 VALIDATION_ERROR с details', () => {
    const r = z.object({ n: z.number() }).strict().safeParse({ n: 'x', extra: 1 });
    expect(r.success).toBe(false);
    const e = toAppError((r as { error: z.ZodError }).error);
    expect(e.status).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(e.details)).toBe(true);
  });

  it('URIError (нераскодируемый параметр пути) — 400, а не 500', () => {
    const e = toAppError(new URIError("Failed to decode param '%'"));
    expect(e.status).toBe(400);
    expect(e.code).toBe('BAD_REQUEST');
    expect(e.message).not.toMatch(/decode|param/);
  });

  it('ошибки body-parser: слишком большое тело, битый JSON, кодировка', () => {
    expect(toAppError(Object.assign(new Error('x'), { type: 'entity.too.large' })).status).toBe(413);
    expect(toAppError(Object.assign(new Error('x'), { type: 'entity.parse.failed' })).code).toBe('INVALID_JSON');
    expect(toAppError(Object.assign(new Error('x'), { type: 'charset.unsupported' })).status).toBe(415);
    expect(toAppError(Object.assign(new Error('x'), { type: 'encoding.unsupported' })).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('ошибка БД из pg превращается в соответствующий AppError', () => {
    expect(toAppError(dbError('GR002')).status).toBe(402);
  });

  it('неизвестная ошибка — 500 INTERNAL без подробностей', () => {
    const e = toAppError(new TypeError('Cannot read properties of undefined (reading "password")'));
    expect(e.status).toBe(500);
    expect(e.code).toBe('INTERNAL');
    expect(e.message).not.toMatch(/password|undefined|TypeError/);
    expect(toAppError('просто строка').status).toBe(500);
    expect(toAppError(undefined).status).toBe(500);
  });

  it('429 несёт заголовок Retry-After', () => {
    const e = tooManyRequests(120);
    expect(e.status).toBe(429);
    expect(e.headers).toEqual({ 'Retry-After': '120' });
    expect(e.message).toContain('120');
  });
});

describe('zodDetails', () => {
  it('сообщения по-русски, путь через точку', () => {
    const schema = z.object({ a: z.object({ b: z.number() }), c: z.enum(['x', 'y']), d: z.string().email() }).strict();
    const r = schema.safeParse({ a: { b: 'str' }, c: 'z', d: 'nope', extra: 1 });
    const details = zodDetails((r as { error: z.ZodError }).error);
    const byPath = Object.fromEntries(details.map((d) => [d.path, d.message]));
    expect(byPath['a.b']).toBe('Неверный тип значения');
    expect(byPath['c']).toBe('Недопустимое значение');
    expect(byPath['d']).toBe('Неверный формат');
    expect(byPath['']).toBe('Лишние поля в запросе');
  });

  it('отсутствующее поле — «Обязательное поле»', () => {
    const r = z.object({ a: z.string() }).safeParse({});
    expect(zodDetails((r as { error: z.ZodError }).error)).toEqual([{ path: 'a', message: 'Обязательное поле' }]);
  });

  it('too_small / too_big / invalid_union — по-русски, без латиницы', () => {
    const schema = z.object({
      s: z.string().min(20),
      t: z.string().max(3),
      n: z.number().min(1),
      m: z.number().max(5),
      a: z.array(z.string()).min(1),
      u: z.union([z.string(), z.number()]),
      c: z.string().min(2, 'Слишком коротко'),
    });
    const r = schema.safeParse({ s: 'k', t: 'long', n: 0, m: 9, a: [], u: null, c: 'x' });
    const byPath = Object.fromEntries(zodDetails((r as { error: z.ZodError }).error).map((d) => [d.path, d.message]));
    expect(byPath['s']).toBe('Не короче 20 симв.');
    expect(byPath['t']).toBe('Не длиннее 3 симв.');
    expect(byPath['n']).toBe('Не меньше 1');
    expect(byPath['m']).toBe('Не больше 5');
    expect(byPath['a']).toBe('Не меньше 1 элементов');
    expect(byPath['u']).toBe('Неверное значение');
    expect(byPath['c']).toBe('Слишком коротко');
    for (const m of Object.values(byPath)) expect(m).not.toMatch(/[A-Za-z]{3,}/);
  });
});

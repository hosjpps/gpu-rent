import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, ORIGIN, bare, closeAll, loginAs, makeApp, newUser } from './helpers';
import type { TestUser } from './helpers';

const app = makeApp();
let user: TestUser;
let admin: Api;

beforeAll(async () => {
  user = await newUser(app, { balance: 1000 });
  admin = await loginAs(app, ADMIN.email, ADMIN.password);
});
afterAll(closeAll);

// Ни один «странный» запрос не должен приводить к 500: это либо отказ клиенту (4xx), либо обычный ответ.
describe('странные запросы не дают 500', () => {
  const weirdQueries = [
    '/api/instances?all[]=1',
    '/api/instances?all[a]=1',
    '/api/billing/transactions?limit[a]=1',
    '/api/billing/transactions?limit=1&limit=2',
    '/api/billing/transactions?cursor[]=x',
    '/api/billing/transactions?cursor=%',
    '/api/billing/spend?from[]=2025-01-01',
    '/api/billing/spend?from=2025-01-01&to[x]=1',
    '/api/billing/spend?from=%E0%A4%A',
  ];

  it.each(weirdQueries)('клиент GET %s -> 4xx/2xx', async (url) => {
    const res = await user.api.get(url);
    expect(res.status, url).toBeLessThan(500);
    expect(res.body).toBeTypeOf('object');
  });

  it.each(['/api/admin/users?q[]=a', '/api/admin/users?q[a]=b&limit=1', '/api/admin/users?limit=1&limit=2', '/api/admin/audit?cursor[]=1', '/api/admin/dashboard?from[]=2025-01-01'])(
    'администратор GET %s -> не 500',
    async (url) => {
      const res = await admin.get(url);
      expect(res.status, url).toBeLessThan(500);
    },
  );

  it.each(['/api/instances/%00', '/api/instances/%', '/api/instances/%E0%A4%A', '/api/volumes/1e3', '/api/volumes/0x10', '/api/volumes/-1', '/api/volumes/1.5', '/api/ssh-keys/abc'])(
    'GET/DELETE %s -> не 500',
    async (url) => {
      expect((await user.api.get(url)).status, url).toBeLessThan(500);
      expect((await user.api.delete(url)).status, url).toBeLessThan(500);
    },
  );

  it('неподходящие методы и заголовки', async () => {
    for (const [method, url] of [['put', '/api/instances'], ['patch', '/api/auth/me'], ['delete', '/api/auth/me'], ['put', '/api/catalog/gpus']] as const) {
      const res = await bare(app)[method](url).set('X-Requested-With', 'fetch').set('Origin', ORIGIN);
      expect(res.status, `${method} ${url}`).toBeLessThan(500);
    }
    const html = await bare(app).get('/api/catalog/gpus').set('Accept', 'text/html');
    expect(html.status).toBeLessThan(500);
  });

  it('тело неожиданного вида: массив, число, строка, null, вложенность, неверный Content-Type', async () => {
    const post = (body: unknown, type = 'application/json') =>
      bare(app).post('/api/auth/login').set('Content-Type', type).set('X-Requested-With', 'fetch').set('Origin', ORIGIN).set('X-Forwarded-For', '10.20.30.40').send(typeof body === 'string' ? body : JSON.stringify(body));
    for (const body of [[], [1, 2], 42, '"строка"', 'null', { email: { $ne: null }, password: { $ne: null } }, { email: ['a@b.cc'], password: 'x' }, { email: 'a@b.cc', password: ['x'] }]) {
      const res = await post(body as never);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await post('email=a@b.cc&password=x', 'application/x-www-form-urlencoded')).status).toBe(400);
    expect((await post('{"email":"a@b.cc","password":"x"}', 'text/plain')).status).toBe(400); // не JSON по типу: тело не разобрано
    const deep = '['.repeat(5000) + ']'.repeat(5000);
    expect((await post(deep)).status).toBeLessThan(500);
  });

  it('мусор в заголовках аутентификации и сессии', async () => {
    for (const headers of [{ Authorization: 'Bearer %' }, { Authorization: 'Bearer ' + 'x'.repeat(8000) }, { Cookie: 'sid=%; sid=%E0' }, { Cookie: 'a=b; ; =; sid' }]) {
      const res = await bare(app).get('/api/instances').set(headers);
      expect(res.status, JSON.stringify(headers).slice(0, 30)).toBeLessThan(500);
    }
  });

  it('ответы об ошибках всегда JSON в едином формате', async () => {
    for (const res of [await bare(app).get('/api/instances/%'), await bare(app).get('/api/nothing'), await bare(app).post('/api/auth/login').send('{')]) {
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error).toEqual({ code: expect.any(String), message: expect.any(String) });
    }
  });
});

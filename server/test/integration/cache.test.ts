import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, CRON_SECRET, closeAll, loginAs, makeApp, newUser, bare, uniq } from './helpers';
import type { TestUser } from './helpers';

const app = makeApp();
const PUBLIC = 'public, s-maxage=30, stale-while-revalidate=60';
const PRIVATE = 'private, no-store';

let a: TestUser;
let b: TestUser;
let admin: Api;

beforeAll(async () => {
  a = await newUser(app, { balance: 1000 });
  b = await newUser(app);
  admin = await loginAs(app, ADMIN.email, ADMIN.password);
});
afterAll(closeAll);

describe('публичный каталог: общий кэш CDN', () => {
  it('GET /api/catalog/gpus кэшируется на 30 с + stale-while-revalidate 60 с', async () => {
    const res = await bare(app).get('/api/catalog/gpus');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(PUBLIC);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.length).toBeGreaterThan(10);
  });

  it('GET /api/catalog/templates — тоже публичный кэш', async () => {
    const res = await bare(app).get('/api/catalog/templates');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(PUBLIC);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('A прогревает URL, B и аноним получают тот же ответ байт в байт (в том числе ETag)', async () => {
    for (const url of ['/api/catalog/gpus', '/api/catalog/templates']) {
      const forA = await a.api.get(url);
      const forB = await b.api.get(url);
      const anon = await bare(app).get(url);
      expect(forA.status).toBe(200);
      expect(forB.text).toBe(forA.text);
      expect(anon.text).toBe(forA.text);
      expect(forB.headers['etag']).toBe(forA.headers['etag']);
      expect(anon.headers['etag']).toBe(forA.headers['etag']);
      expect(forA.headers['cache-control']).toBe(PUBLIC);
      expect(forB.headers['cache-control']).toBe(PUBLIC);
    }
  });

  it('ответ не зависит ни от cookie, ни от Authorization, и не выдаёт cookie сам', async () => {
    const plain = await bare(app).get('/api/catalog/gpus');
    const withJunk = await bare(app).get('/api/catalog/gpus').set('Cookie', 'sid=abcdef; other=1').set('Authorization', 'Bearer not-a-key');
    expect(withJunk.status).toBe(200);
    expect(withJunk.text).toBe(plain.text);
    expect(withJunk.headers['set-cookie']).toBeUndefined();
    expect(withJunk.headers['vary'] ?? '').not.toMatch(/cookie|authorization/i);
  });

  it('личный шаблон A не попадает в публичный список ни для A, ни для B, ни для анонима', async () => {
    const name = `private-${uniq()}`;
    const created = await a.api.post('/api/templates', { name, dockerImage: 'registry.example.com/a/env:1', defaultDiskGb: 20 });
    expect(created.status).toBe(201);

    for (const res of [await a.api.get('/api/catalog/templates'), await b.api.get('/api/catalog/templates'), await bare(app).get('/api/catalog/templates')]) {
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(name);
      expect(res.body.every((t: { isPublic: boolean }) => t.isPublic)).toBe(true);
      expect(res.body.length).toBe(8);
    }
  });

  it('предложения для разных пользователей одинаковы даже когда у одного из них занято несколько GPU', async () => {
    const before = await bare(app).get('/api/catalog/gpus');
    const first = before.body[0];
    const run = await a.api.post('/api/instances', {
      name: 'cache-check',
      datacenterCode: first.datacenter.code,
      gpuModel: first.model.name,
      gpuCount: 1,
      pricingType: 'spot',
      templateId: 1,
    });
    expect(run.status).toBe(201);
    const forA = await a.api.get('/api/catalog/gpus');
    const forB = await b.api.get('/api/catalog/gpus');
    expect(forB.text).toBe(forA.text);
    expect(forA.body[0].free).toBe(first.free - 1);
  });
});

describe('персональные ответы: private, no-store', () => {
  it('GET /api/templates/mine никогда не кэшируется и показывает только свои шаблоны', async () => {
    const name = `mine-${uniq()}`;
    await a.api.post('/api/templates', { name, dockerImage: 'registry.example.com/a/env:2', defaultDiskGb: 20 });
    const mineA = await a.api.get('/api/templates/mine');
    expect(mineA.status).toBe(200);
    expect(mineA.headers['cache-control']).toBe(PRIVATE);
    expect(mineA.text).toContain(name);
    const mineB = await b.api.get('/api/templates/mine');
    expect(mineB.headers['cache-control']).toBe(PRIVATE);
    expect(mineB.text).not.toContain(name);
    const anon = await bare(app).get('/api/templates/mine');
    expect(anon.status).toBe(401);
    expect(anon.headers['cache-control']).toBe(PRIVATE);
  });

  it('все остальные эндпоинты (успех и отказ) отдают private, no-store', async () => {
    const urls = [
      '/api/auth/me',
      '/api/instances',
      '/api/volumes',
      '/api/billing/balance',
      '/api/billing/transactions',
      '/api/billing/spend',
      '/api/ssh-keys',
      '/api/api-keys',
      '/api/templates/mine',
      '/api/health',
      '/api/health?deep=1',
      '/api/internal/billing',
      '/api/admin/dashboard',
      '/api/admin/prices',
      '/api/admin/prices/storage',
      '/api/admin/infrastructure',
      '/api/admin/users',
      '/api/admin/audit',
      '/api/no/such/route',
    ];
    for (const url of urls) {
      for (const [who, api] of [['клиент', a.api], ['аноним', new Api(app)], ['админ', admin]] as const) {
        const res = await api.get(url);
        expect(res.headers['cache-control'], `${who} ${url} -> ${res.status}`).toBe(PRIVATE);
      }
    }
  });

  it('POST-ответы тоже не кэшируются: вход, регистрация, платёж, cron', async () => {
    const pay = await a.api.post('/api/payments', { amount: 100 });
    expect(pay.headers['cache-control']).toBe(PRIVATE);
    const login = await new Api(app).post('/api/auth/login', { email: a.email, password: a.password });
    expect(login.headers['cache-control']).toBe(PRIVATE);
    const reg = await new Api(app).post('/api/auth/register', { email: `c-${uniq()}@example.test`, password: 'longenough1', fullName: 'Иван' });
    expect(reg.headers['cache-control']).toBe(PRIVATE);
    const cron = await bare(app).post('/api/internal/billing').set('Authorization', `Bearer ${CRON_SECRET}`);
    expect(cron.headers['cache-control']).toBe(PRIVATE);
    const webhook = await bare(app).post('/api/webhooks/payments').set('Content-Type', 'application/json').send('{}');
    expect(webhook.headers['cache-control']).toBe(PRIVATE);
  });

  it('ошибки публичного каталога (например, 404 на неизвестном пути каталога) не попадают в общий кэш', async () => {
    const res = await bare(app).get('/api/catalog/nothing');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe(PRIVATE);
  });

  it('публичный Cache-Control есть ровно у двух адресов каталога и больше ни у одного', async () => {
    const publicUrls = new Set(['/api/catalog/gpus', '/api/catalog/templates']);
    const probes = ['/api/auth/me', '/api/instances', '/api/billing/balance', '/api/templates/mine', '/api/ssh-keys', '/api/health', ...publicUrls];
    for (const url of probes) {
      const res = await a.api.get(url);
      expect(res.headers['cache-control'] === PUBLIC, url).toBe(publicUrls.has(url));
    }
  });
});

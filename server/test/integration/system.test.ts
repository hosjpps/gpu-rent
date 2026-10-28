import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, CRON_SECRET, balanceOf, closeAll, launch, loginAs, makeApp, newUser, pickOffer, bare, sql } from './helpers';
import type { Offer } from './helpers';

const app = makeApp();
const bearer = (t: string) => `Bearer ${t}`;

afterAll(closeAll);

describe('GET /api/health', () => {
  it('быстрый ответ без БД: status, version, time', async () => {
    const res = await bare(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toEqual(expect.any(String));
    expect(Date.now() - Date.parse(res.body.time)).toBeLessThan(5000);
    expect(res.body.db).toBeUndefined();
    expect(res.body.lastBillingAt).toBeUndefined();
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('?deep=1 проверяет БД и отдаёт lastBillingAt (null или момент последнего прохода)', async () => {
    const res = await bare(app).get('/api/health?deep=1');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe('ok');
    expect(res.body).toHaveProperty('lastBillingAt');
    if (res.body.lastBillingAt !== null) expect(Number.isNaN(Date.parse(res.body.lastBillingAt))).toBe(false);
  });

  it('после прохода биллинга lastBillingAt совпадает с журналом billing_runs', async () => {
    const cron = await bare(app).get('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    expect(cron.status).toBe(200);
    const res = await bare(app).get('/api/health?deep=1');
    const [row] = await sql<{ at: Date }>('SELECT max(finished_at) AS at FROM billing_runs');
    expect(new Date(res.body.lastBillingAt).getTime()).toBe(row!.at.getTime());
    expect(Date.now() - Date.parse(res.body.lastBillingAt)).toBeLessThan(60_000);
  });
});

describe('проход биллинга /api/internal/billing', () => {
  it.each(['get', 'post'] as const)('%s без секрета и с чужим секретом — 401 и WWW-Authenticate', async (method) => {
    for (const headers of [{}, { Authorization: bearer('wrong-secret-0123456789') }, { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }, { Authorization: bearer(CRON_SECRET.slice(0, -1)) }]) {
      const res = await bare(app)[method]('/api/internal/billing').set(headers);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CRON_SECRET');
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('секрет в строке запроса не принимается', async () => {
    const res = await bare(app).get(`/api/internal/billing?token=${CRON_SECRET}&secret=${CRON_SECRET}`);
    expect(res.status).toBe(401);
  });

  it('сессия администратора секрета не заменяет', async () => {
    const admin = await loginAs(app, ADMIN.email, ADMIN.password);
    expect((await admin.get('/api/internal/billing')).status).toBe(401);
    expect((await admin.post('/api/internal/billing')).status).toBe(401);
  });

  it.each(['get', 'post'] as const)('%s с верным секретом выполняет проход: ответ, no-store, запись в журнале', async (method) => {
    const [before] = await sql<{ n: number }>('SELECT count(*)::int AS n FROM billing_runs');
    const res = await bare(app)[method]('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      users: expect.any(Number),
      records: expect.any(Number),
      charged: expect.stringMatching(/^\d+(\.\d+)?$/),
      stopped: expect.any(Number),
      cleaned: { sessions: expect.any(Number), attempts: expect.any(Number), tokens: expect.any(Number), runs: expect.any(Number) },
    });
    const [after] = await sql<{ n: number }>('SELECT count(*)::int AS n FROM billing_runs');
    expect(after!.n).toBe(before!.n + 1);
  });

  it('начисляет за работу инстансов, останавливает при нулевом балансе и освобождает GPU; баланс уходит в минус на интервал между проходами', async () => {
    const offer = await pickOffer(app, 8);
    const owner = await newUser(app, { balance: 100 });
    const cost = Number(offer.priceOnDemand);
    // баланса хватает ровно на старт (>= стоимости часа), но не на пять часов работы
    const topup = Math.ceil(cost) + 1;
    const poor = await newUser(app, { balance: topup });
    const { id } = await launch(poor, offer);
    await launch(owner, offer, { pricingType: 'spot' });

    await sql("UPDATE instances SET last_billed_at = now() - interval '5 hours' WHERE id = $1", [id]);
    const res = await bare(app).post('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    expect(res.status).toBe(200);
    expect(res.body.records).toBeGreaterThanOrEqual(1);
    expect(res.body.stopped).toBeGreaterThanOrEqual(1);

    expect(Number(await balanceOf(poor.id))).toBeLessThan(0);
    const inst = await poor.api.get(`/api/instances/${id}`);
    expect(inst.body.status).toBe('stopped');
    const gpus = await sql<{ open: number }>("SELECT count(*) FILTER (WHERE upper_inf(allocated_during))::int AS open FROM instance_gpus WHERE instance_id = $1", [id]);
    expect(gpus[0]!.open).toBe(0);
    const tx = await sql<{ amount: string }>("SELECT amount FROM transactions WHERE user_id = $1 AND type = 'charge'", [poor.id]);
    expect(tx).toHaveLength(1);
    expect(Number(tx[0]!.amount)).toBeLessThan(-cost * 4.9);
    const audit = await sql("SELECT 1 FROM audit_log WHERE action = 'instance.autostop_low_balance' AND entity_id = $1", [id]);
    expect(audit).toHaveLength(1);

    // возобновить в долг нельзя
    const resume = await poor.api.post(`/api/instances/${id}/resume`);
    expect(resume.status).toBe(402);
    expect(resume.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('повторный проход сразу после первого ничего не начисляет дважды', async () => {
    const offer = await pickOffer(app, 8);
    const u = await newUser(app, { balance: 5000 });
    const { id } = await launch(u, offer);
    await sql("UPDATE instances SET last_billed_at = now() - interval '2 hours' WHERE id = $1", [id]);
    const r1 = await bare(app).post('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    const mid = await balanceOf(u.id);
    const r2 = await bare(app).post('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const charges = await sql<{ n: number }>("SELECT count(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'charge'", [u.id]);
    // второй проход может добавить доли секунды за время между проходами, но не второй раз два часа
    expect(charges[0]!.n).toBeLessThanOrEqual(2);
    expect(Number(mid) - Number(await balanceOf(u.id))).toBeLessThan(Number(offer.priceOnDemand) * 0.05);
  });

  it('очищает просроченные сессии и старые записи лимитера', async () => {
    const u = await newUser(app);
    await sql("INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES ($1, decode(repeat('ab', 32), 'hex'), now() - interval '9 days', now() - interval '2 days')", [u.id]);
    await sql("INSERT INTO auth_attempts (scope, key, created_at) VALUES ('login_email', 'old@example.test', now() - interval '3 days')");
    const res = await bare(app).post('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    expect(res.body.cleaned.sessions).toBeGreaterThanOrEqual(1);
    expect(res.body.cleaned.attempts).toBeGreaterThanOrEqual(1);
    expect(await sql("SELECT 1 FROM sessions WHERE token_hash = decode(repeat('ab', 32), 'hex')")).toHaveLength(0);
    expect(await sql("SELECT 1 FROM auth_attempts WHERE key = 'old@example.test'")).toHaveLength(0);
    expect((await u.api.get('/api/auth/me')).status).toBe(200); // живая сессия не тронута
  });

  it('создаёт партицию на следующий месяц и обновляет витрину выручки', async () => {
    await bare(app).post('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    const next = await sql<{ name: string }>(
      "SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'usage_records' AND c.relname = 'usage_records_' || to_char(date_trunc('month', now()) + interval '1 month', 'YYYY_MM')",
    );
    expect(next).toHaveLength(1);
  });

  it('секрет не задан: локально эндпоинт выключен (404), в production — ошибка настройки (503)', async () => {
    const dev = makeApp({ CRON_SECRET: undefined });
    const devRes = await bare(dev).get('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    expect(devRes.status).toBe(404);
    expect(devRes.headers['cache-control']).toBe('private, no-store');

    const prod = makeApp({ CRON_SECRET: undefined, NODE_ENV: 'production' });
    const prodRes = await bare(prod).post('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    expect(prodRes.status).toBe(503);
    expect(prodRes.body.error.code).toBe('CRON_NOT_CONFIGURED');
  });
});

describe('заголовки безопасности и формат ошибок', () => {
  it('helmet: строгая CSP для API, nosniff, нет X-Powered-By, CORP same-origin', async () => {
    const res = await bare(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['strict-transport-security']).toBeUndefined(); // не production
  });

  it('в production включён HSTS', async () => {
    const prod = makeApp({ NODE_ENV: 'production' });
    const res = await bare(prod).get('/api/health');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=63072000; includeSubDomains/);
  });

  it('у каждого запроса свой X-Request-Id', async () => {
    const a = await bare(app).get('/api/health');
    const b = await bare(app).get('/api/health');
    expect(a.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('несуществующий адрес API — 404 в едином формате ошибки', async () => {
    const res = await bare(app).get('/api/nothing/here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: expect.stringMatching(/[А-Яа-я]/) } });
    const post = await new Api(app).post('/api/nothing/here', {});
    expect(post.status).toBe(404);
  });

  it('тело больше 32 КБ — 413, битый JSON — 400', async () => {
    const big = await new Api(app).post('/api/auth/login', { email: 'a@b.cc', password: 'x'.repeat(40_000) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const bad = await new Api(app).post('/api/auth/login', undefined).set('Content-Type', 'application/json').send('{"email": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
  });

  it('ошибка не раскрывает внутренности: нет стектрейса, путей и имён таблиц', async () => {
    const samples = [
      await new Api(app).post('/api/auth/login', { email: 'x' }),
      await new Api(app).get('/api/instances/not-a-uuid'),
      await bare(app).post('/api/webhooks/payments').send('garbage'),
      await new Api(app).get('/api/admin/users'),
    ];
    for (const res of samples) {
      expect(JSON.stringify(res.body)).not.toMatch(/\bat \w+.*\(|node_modules|\.ts:|SELECT |gpu_rent\.|pg_|stack/i);
    }
  });
});

describe('предложение в проходе биллинга учитывается для нескольких пользователей', () => {
  let offer: Offer;
  beforeAll(async () => {
    offer = await pickOffer(app, 8);
  });

  it('проход начисляет каждому своё, не смешивая пользователей', async () => {
    const u1 = await newUser(app, { balance: 3000 });
    const u2 = await newUser(app, { balance: 3000 });
    const i1 = await launch(u1, offer);
    const i2 = await launch(u2, offer, { gpuCount: 2 });
    await sql("UPDATE instances SET last_billed_at = now() - interval '1 hour' WHERE id IN ($1, $2)", [i1.id, i2.id]);
    await bare(app).post('/api/internal/billing').set('Authorization', bearer(CRON_SECRET));
    const spent1 = 3000 - Number(await balanceOf(u1.id));
    const spent2 = 3000 - Number(await balanceOf(u2.id));
    const hourly = Number(offer.priceOnDemand);
    expect(spent1).toBeGreaterThan(hourly * 0.99);
    expect(spent1).toBeLessThan(hourly * 1.1);
    expect(spent2).toBeGreaterThan(hourly * 2 * 0.99);
    expect(spent2).toBeLessThan(hourly * 2 * 1.1);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { closePool, isPoolCreated } from '../../src/db';
import { Api, makeApp, bare } from './helpers';

// Адрес, где БД нет: порт 1 отвечает отказом сразу. Файл отдельный, потому что пул соединений общий на модуль.
const dead = makeApp({ DATABASE_URL: 'postgres://gpu_rent_web:x@127.0.0.1:1/gpu_rent_test' });

afterAll(closePool);

describe('БД недоступна', () => {
  it('/api/health отвечает 200 и не трогает БД', async () => {
    const res = await bare(dead).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(isPoolCreated()).toBe(false);
  });

  it('/api/health?deep=1 — 503 с db: "down" (внешний мониторинг увидит сбой)', async () => {
    const res = await bare(dead).get('/api/health?deep=1');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'error', db: 'down', lastBillingAt: null });
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('запросы к данным — 503 DB_UNAVAILABLE по-русски, без деталей подключения', async () => {
    const res = await bare(dead).get('/api/catalog/gpus');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DB_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|gpu_rent/);
    expect(res.headers['cache-control']).toBe('private, no-store'); // сбой не должен осесть в кэше CDN

    const login = await new Api(dead).post('/api/auth/login', { email: 'a@b.cc', password: 'longenough1' });
    expect(login.status).toBe(503);
  });
});

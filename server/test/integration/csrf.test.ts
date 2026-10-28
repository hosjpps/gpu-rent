import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, CRON_SECRET, closeAll, makeApp, newUser, bare, sendWebhook, sql } from './helpers';
import type { TestUser } from './helpers';

const app = makeApp();
let user: TestUser;

beforeAll(async () => {
  user = await newUser(app, { balance: 500 });
});
afterAll(closeAll);

const expectCsrf = (res: Response): void => {
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('CSRF');
};

describe('CSRF: запросы, подтверждённые cookie', () => {
  it('небезопасный метод без X-Requested-With — 403 CSRF', async () => {
    const attempts: [string, string, object | undefined][] = [
      ['post', '/api/payments', { amount: 100 }],
      ['post', '/api/volumes', { name: 'v', datacenterCode: 'MSK-1', sizeGb: 10 }],
      ['post', '/api/instances', { name: 'x' }],
      ['post', '/api/ssh-keys', { name: 'k', publicKey: 'ssh-ed25519 AAAA' }],
      ['post', '/api/api-keys', { name: 'k' }],
      ['post', '/api/auth/password', { currentPassword: 'a', newPassword: 'b' }],
      ['post', '/api/auth/logout', undefined],
      ['delete', '/api/ssh-keys/1', undefined],
      ['delete', '/api/api-keys/1', undefined],
      ['delete', '/api/volumes/1', undefined],
    ];
    for (const [method, url, body] of attempts) {
      const res = method === 'post' ? await user.api.post(url, body, { csrf: false }) : await user.api.delete(url, { csrf: false });
      expectCsrf(res);
    }
  });

  it('заголовок есть, но Origin чужой, пустой «null» или отсутствует — 403 CSRF', async () => {
    expectCsrf(await user.api.post('/api/payments', { amount: 100 }, { origin: 'https://evil.example' }));
    expectCsrf(await user.api.post('/api/payments', { amount: 100 }, { origin: 'null' }));
    expectCsrf(await user.api.post('/api/payments', { amount: 100 }, { origin: null }));
    expectCsrf(await user.api.post('/api/payments', { amount: 100 }, { origin: 'http://localhost:3000.evil.example' }));
  });

  it('Origin верный, но X-Requested-With другой — 403 CSRF', async () => {
    expectCsrf(await user.api.post('/api/payments', { amount: 100 }, { csrf: false, headers: { Origin: 'http://localhost:3000', 'X-Requested-With': 'XMLHttpRequest' } }));
  });

  it('отклонённый запрос ничего не меняет', async () => {
    const before = await sql<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [user.id]);
    expectCsrf(await user.api.post('/api/payments', { amount: 100 }, { origin: 'https://evil.example' }));
    const after = await sql<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [user.id]);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('с обоими заголовками запрос выполняется', async () => {
    const res = await user.api.post('/api/payments', { amount: 100 });
    expect(res.status).toBe(201);
  });

  it('безопасные методы заголовков не требуют', async () => {
    expect((await user.api.get('/api/auth/me')).status).toBe(200);
    expect((await user.api.get('/api/instances')).status).toBe(200);
    expect((await user.api.get('/api/catalog/gpus')).status).toBe(200);
  });

  it('анонимный запрос тоже проверяется: login-CSRF и регистрация', async () => {
    expectCsrf(await new Api(app).post('/api/auth/login', { email: user.email, password: user.password }, { csrf: false }));
    expectCsrf(await new Api(app).post('/api/auth/register', { email: 'x@example.test', password: 'longenough1', fullName: 'Иван' }, { csrf: false }));
    expectCsrf(await new Api(app).post('/api/auth/verify', { token: 'x'.repeat(43) }, { csrf: false }));
  });
});

describe('CSRF: исключения', () => {
  it('запросы с Bearer-ключом не требуют ни X-Requested-With, ни Origin', async () => {
    const created = await user.api.post('/api/api-keys', { name: 'ci' });
    expect(created.status).toBe(201);
    const viaKey = new Api(app);
    viaKey.bearer = created.body.key;

    const paid = await viaKey.post('/api/payments', { amount: 100 }, { csrf: false });
    expect(paid.status).toBe(201);
    const vol = await viaKey.post('/api/volumes', { name: 'v', datacenterCode: 'MSK-1', sizeGb: 10 }, { csrf: false });
    expect(vol.status).toBe(201);
    expect((await viaKey.delete(`/api/volumes/${vol.body.id}`, { csrf: false })).status).toBe(204);
  });

  it('вебхук исключён: без заголовков доходит до проверки подписи (401), а не отсекается как CSRF', async () => {
    const res = await sendWebhook(app, '{"paymentId":"x","status":"succeeded","amount":"10.00"}', 'bad');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('cron исключён: проверяется секрет, а не CSRF', async () => {
    const noSecret = await bare(app).post('/api/internal/billing');
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error.code).toBe('INVALID_CRON_SECRET');
    const ok = await bare(app).post('/api/internal/billing').set('Authorization', `Bearer ${CRON_SECRET}`);
    expect(ok.status).toBe(200);
  });

  it('Bearer не отменяет проверку вообще: неверный ключ даёт 401, а не доступ', async () => {
    const res = await bare(app).post('/api/payments').send({ amount: 100 }).set('Authorization', 'Bearer gr_' + 'B'.repeat(43));
    expect(res.status).toBe(401);
  });
});

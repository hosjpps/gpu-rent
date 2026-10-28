import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPayload } from '../../src/webhook';
import { Api, WEBHOOK_SECRET, balanceOf, closeAll, makeApp, newUser, providerIdOf, bare, sendWebhook, sql, webhookBody } from './helpers';
import type { TestUser } from './helpers';

const app = makeApp();
let user: TestUser;

beforeAll(async () => {
  user = await newUser(app);
});
afterAll(closeAll);

async function createPayment(u: TestUser, amount: string | number): Promise<{ id: number; providerId: string; amount: string }> {
  const res = await u.api.post('/api/payments', { amount });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.payment.id, providerId: await providerIdOf(res.body.payment.id), amount: res.body.payment.amount };
}

const topups = async (userId: number): Promise<number> =>
  (await sql<{ n: number }>("SELECT count(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'topup'", [userId]))[0]!.n;
const statusOf = async (id: number): Promise<string> => (await sql<{ status: string }>('SELECT status FROM payments WHERE id = $1', [id]))[0]!.status;

describe('создание платежа', () => {
  it('201: платёж pending, ссылка на оплату; владелец берётся из сессии', async () => {
    const res = await user.api.post('/api/payments', { amount: '500.00' });
    expect(res.status).toBe(201);
    expect(res.body.payment).toEqual({ id: expect.any(Number), amount: '500.00', status: 'pending', createdAt: expect.any(String), paidAt: null });
    expect(res.body.confirmationUrl).toContain(`/billing?payment=${res.body.payment.id}`);
    expect(res.headers['cache-control']).toBe('private, no-store');

    const [row] = await sql<{ user_id: number; provider: string; provider_payment_id: string }>('SELECT user_id, provider, provider_payment_id FROM payments WHERE id = $1', [res.body.payment.id]);
    expect(row!.user_id).toBe(user.id);
    expect(row!.provider).toBe('demo');
    expect(row!.provider_payment_id).toMatch(/^demo_[0-9a-f-]{36}$/);
    expect(await balanceOf(user.id)).not.toBe('500.0000'); // создание платежа деньги не зачисляет
    expect(await sql("SELECT 1 FROM audit_log WHERE action = 'payment.create' AND entity_id = $1 AND actor_user_id = $2", [String(res.body.payment.id), user.id])).toHaveLength(1);
  });

  it('число принимается так же, как строка', async () => {
    const res = await user.api.post('/api/payments', { amount: 250 });
    expect(res.status).toBe(201);
    expect(res.body.payment.amount).toBe('250.00');
  });

  it.each([5, 9.99, 100000.01, 'abc', 10.123, -50, '', '1e3', null])('сумма %j отклоняется', async (amount) => {
    const before = await sql<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [user.id]);
    const res = await user.api.post('/api/payments', { amount });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const after = await sql<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [user.id]);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('пустое тело — 400; без входа — 401', async () => {
    expect((await user.api.post('/api/payments', {})).status).toBe(400);
    expect((await new Api(app).post('/api/payments', { amount: 100 })).status).toBe(401);
  });

  it.each([['userId', 1], ['user_id', 1], ['status', 'succeeded'], ['provider', 'demo'], ['providerPaymentId', 'x']])(
    'платёж за чужой счёт или сразу «оплаченный» невозможен: поле %s отклоняется',
    async (field, value) => {
      const victim = await newUser(app);
      const res = await user.api.post('/api/payments', { amount: 100, [field]: field.startsWith('user') ? victim.id : value });
      expect(res.status).toBe(400);
      expect(await sql('SELECT 1 FROM payments WHERE user_id = $1', [victim.id])).toHaveLength(0);
    },
  );
});

describe('демо-оплата', () => {
  it('зачисляет сумму один раз; повторная оплата не зачисляет второй раз', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, '1000.50');
    const r1 = await u.api.post(`/api/payments/${p.id}/demo-pay`);
    expect(r1.status).toBe(200);
    expect(r1.body.credited).toBe(true);
    expect(r1.body.payment).toMatchObject({ id: p.id, status: 'succeeded', amount: '1000.50' });
    expect(r1.body.payment.paidAt).not.toBeNull();
    expect(await balanceOf(u.id)).toBe('1000.5000');

    const r2 = await u.api.post(`/api/payments/${p.id}/demo-pay`);
    expect(r2.status).toBe(200);
    expect(r2.body.credited).toBe(false);
    expect(await balanceOf(u.id)).toBe('1000.5000');
    expect(await topups(u.id)).toBe(1);
    expect(await sql("SELECT 1 FROM audit_log WHERE action = 'payment.credited' AND entity_id = $1", [String(p.id)])).toHaveLength(1);
  });

  it('чужой платёж оплатить нельзя: 404, у владельца ничего не меняется', async () => {
    const owner = await newUser(app);
    const attacker = await newUser(app);
    const p = await createPayment(owner, 300);
    const res = await attacker.api.post(`/api/payments/${p.id}/demo-pay`);
    expect(res.status).toBe(404);
    expect(await statusOf(p.id)).toBe('pending');
    expect(await balanceOf(owner.id)).toBe('0.0000');
    expect(await balanceOf(attacker.id)).toBe('0.0000');
  });

  it('несуществующий и некорректный идентификатор; без входа', async () => {
    expect((await user.api.post('/api/payments/99999999/demo-pay')).status).toBe(404);
    expect((await user.api.post('/api/payments/abc/demo-pay')).status).toBe(400);
    expect((await new Api(app).post('/api/payments/1/demo-pay')).status).toBe(401);
  });

  it('при DEMO_PAYMENTS=0 демо-оплаты нет вообще: анониму отвечает 404, а не 401', async () => {
    const real = makeApp({ DEMO_PAYMENTS: '0' });
    const res = await new Api(real).post('/api/payments/1/demo-pay');
    expect(res.status).toBe(404);
  });

  it('при DEMO_PAYMENTS=0 вошедший пользователь тоже получает 404, а создание платежа работает', async () => {
    const real = makeApp({ DEMO_PAYMENTS: '0' });
    const u = await newUser(real);
    const created = await u.api.post('/api/payments', { amount: 100 });
    expect(created.status).toBe(201);
    const res = await u.api.post(`/api/payments/${created.body.payment.id}/demo-pay`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(await statusOf(created.body.payment.id)).toBe('pending');
  });
});

describe('вебхук платёжного шлюза', () => {
  it('верная подпись: платёж зачислен; повторы не зачисляют ещё раз', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 500);
    const raw = webhookBody(p.providerId, p.amount);

    const first = await sendWebhook(app, raw);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, paymentId: p.id, status: 'succeeded', credited: true });
    expect(await balanceOf(u.id)).toBe('500.0000');

    for (let i = 0; i < 3; i++) {
      const again = await sendWebhook(app, raw);
      expect(again.status).toBe(200);
      expect(again.body.credited).toBe(false);
    }
    expect(await balanceOf(u.id)).toBe('500.0000');
    expect(await topups(u.id)).toBe(1);
  });

  it('неверная, отсутствующая или чужая подпись — 401, платёж остаётся pending', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 500);
    const raw = webhookBody(p.providerId, p.amount);
    const cases: [string, string | null][] = [
      ['произвольная строка', 'deadbeef'],
      ['нет заголовка', null],
      ['подпись другого тела', signPayload(WEBHOOK_SECRET, webhookBody(p.providerId, '501.00'))],
      ['подпись другим секретом', signPayload('another-secret-0123456789', raw)],
      ['пустая подпись', ''],
    ];
    for (const [name, sig] of cases) {
      const res = await sendWebhook(app, raw, sig);
      expect(res.status, name).toBe(401);
      expect(res.body.error.code, name).toBe('INVALID_SIGNATURE');
    }
    expect(await statusOf(p.id)).toBe('pending');
    expect(await balanceOf(u.id)).toBe('0.0000');
  });

  it('подпись считается по байтам тела: то же содержимое с другими пробелами не подходит', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 500);
    const compact = webhookBody(p.providerId, p.amount);
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);
    const res = await sendWebhook(app, pretty, signPayload(WEBHOOK_SECRET, compact));
    expect(res.status).toBe(401);
  });

  it('подпись верна, но сумма не совпадает с платежом — 422 CONSISTENCY, деньги не зачисляются', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 500);
    for (const wrong of ['499.00', '5000.00', '500.01', '0.01']) {
      const res = await sendWebhook(app, webhookBody(p.providerId, wrong));
      expect(res.status, wrong).toBe(422);
      expect(res.body.error.code).toBe('CONSISTENCY');
    }
    expect(await statusOf(p.id)).toBe('pending');
    expect(await balanceOf(u.id)).toBe('0.0000');
  });

  it('запись суммы "500" и "500.0" означает то же число и зачисляется', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 500);
    const res = await sendWebhook(app, webhookBody(p.providerId, '500.0'));
    expect(res.status).toBe(200);
    expect(res.body.credited).toBe(true);
  });

  it('пользователя и сумму зачисления определяет платёж в БД, а не тело: userId в теле игнорируется', async () => {
    const payer = await newUser(app);
    const victim = await newUser(app);
    const p = await createPayment(payer, 500);
    const raw = JSON.stringify({ paymentId: p.providerId, status: 'succeeded', amount: p.amount, userId: victim.id, user_id: victim.id });
    const res = await sendWebhook(app, raw);
    expect(res.status).toBe(200);
    expect(await balanceOf(payer.id)).toBe('500.0000');
    expect(await balanceOf(victim.id)).toBe('0.0000');
  });

  it('неизвестный платёж — 404; битый JSON с верной подписью — 400; неверная схема — 400', async () => {
    const unknown = await sendWebhook(app, webhookBody('demo_00000000-0000-0000-0000-000000000000', '10.00'));
    expect(unknown.status).toBe(404);
    const broken = await sendWebhook(app, '{"paymentId": ');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('INVALID_JSON');
    const badStatus = await sendWebhook(app, JSON.stringify({ paymentId: 'x', status: 'refunded', amount: '10.00' }));
    expect(badStatus.status).toBe(400);
    const noAmount = await sendWebhook(app, JSON.stringify({ paymentId: 'x', status: 'succeeded' }));
    expect(noAmount.status).toBe(400);
  });

  it('статус failed не зачисляет; после failed успешное уведомление не оживляет платёж', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 500);
    const failed = await sendWebhook(app, webhookBody(p.providerId, p.amount, 'failed'));
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ status: 'failed', credited: false });
    expect(await balanceOf(u.id)).toBe('0.0000');
    const late = await sendWebhook(app, webhookBody(p.providerId, p.amount, 'succeeded'));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('INVALID_STATE');
    expect(await balanceOf(u.id)).toBe('0.0000');
    expect(await statusOf(p.id)).toBe('failed');
  });

  it('failed после succeeded — 409, деньги остаются зачисленными', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 500);
    await sendWebhook(app, webhookBody(p.providerId, p.amount));
    const res = await sendWebhook(app, webhookBody(p.providerId, p.amount, 'failed'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect(await balanceOf(u.id)).toBe('500.0000');
    expect(await statusOf(p.id)).toBe('succeeded');
  });

  it('шесть одновременных уведомлений по одному платежу зачисляют ровно один раз', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 700);
    const raw = webhookBody(p.providerId, p.amount);
    const results = await Promise.all(Array.from({ length: 6 }, () => sendWebhook(app, raw)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.credited === true)).toHaveLength(1);
    expect(await balanceOf(u.id)).toBe('700.0000');
    expect(await topups(u.id)).toBe(1);
  });

  it('демо-оплата и вебхук взаимно идемпотентны', async () => {
    const u = await newUser(app);
    const p = await createPayment(u, 300);
    await u.api.post(`/api/payments/${p.id}/demo-pay`);
    const hook = await sendWebhook(app, webhookBody(p.providerId, p.amount));
    expect(hook.body.credited).toBe(false);
    expect(await balanceOf(u.id)).toBe('300.0000');
  });

  it('вебхук не требует входа и не использует cookie: запрос с чужой cookie ничего не меняет', async () => {
    const u = await newUser(app);
    const other = await newUser(app);
    const p = await createPayment(u, 400);
    const raw = webhookBody(p.providerId, p.amount);
    const res = await bare(app)
      .post('/api/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signPayload(WEBHOOK_SECRET, raw))
      .set('Authorization', 'Bearer gr_' + 'C'.repeat(43)) // лишний заголовок на вебхук не влияет
      .send(raw);
    expect(res.status).toBe(200);
    expect(await balanceOf(other.id)).toBe('0.0000');
  });

  it('слишком большое тело — 413', async () => {
    const res = await sendWebhook(app, JSON.stringify({ paymentId: 'x'.repeat(40_000), status: 'succeeded', amount: '1.00' }));
    expect(res.status).toBe(413);
  });
});

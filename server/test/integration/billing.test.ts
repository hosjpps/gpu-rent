import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, balanceOf, closeAll, launch, loginAs, makeApp, newUser, pickOffer, sql, topUp } from './helpers';
import type { Offer, TestUser } from './helpers';

const app = makeApp();
let offer: Offer;
let hourly: number;

beforeAll(async () => {
  offer = await pickOffer(app, 8);
  hourly = Number(offer.priceOnDemand);
});
afterAll(closeAll);

const shiftBilling = (id: string, interval: string) =>
  sql(`UPDATE instances SET started_at = now() - interval '${interval}', created_at = now() - interval '${interval}', last_billed_at = now() - interval '${interval}' WHERE id = $1`, [id]);

const moscowToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

describe('биллинг при обращении (fn_bill_current_user)', () => {
  it('GET /billing/balance после ожидания начисляет за работу: баланс уменьшился, в журнале одна операция charge', async () => {
    const u = await newUser(app, { balance: 2000 });
    const { id } = await launch(u, offer);
    await shiftBilling(id, '2 hours');

    const res = await u.api.get('/api/billing/balance');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const charged = Number(res.body.charged);
    expect(charged).toBeGreaterThan(hourly * 2 * 0.999);
    expect(charged).toBeLessThan(hourly * 2 * 1.01);
    expect(res.body.stopped).toBe(0);
    expect(Number(res.body.balance)).toBeCloseTo(2000 - charged, 3);

    const tx = await sql<{ amount: string; usage_id: number }>("SELECT amount, usage_id FROM transactions WHERE user_id = $1 AND type = 'charge'", [u.id]);
    expect(tx).toHaveLength(1);
    expect(Number(tx[0]!.amount)).toBeCloseTo(-charged, 3);
    const usage = await sql<{ quantity: string; amount: string }>('SELECT quantity, amount FROM usage_records WHERE id = $1', [tx[0]!.usage_id]);
    expect(Number(usage[0]!.quantity)).toBeGreaterThanOrEqual(7200);
    expect(Number(usage[0]!.amount)).toBeCloseTo(-Number(tx[0]!.amount), 4);
  });

  it('повторное обращение сразу после — ничего не начисляет (интервал короче минуты)', async () => {
    const u = await newUser(app, { balance: 2000 });
    const { id } = await launch(u, offer);
    await shiftBilling(id, '2 hours');
    await u.api.get('/api/billing/balance');
    const second = await u.api.get('/api/billing/balance');
    expect(second.body.charged).toBe('0.0000');
    const list = await u.api.get('/api/instances');
    expect(list.status).toBe(200);
    expect(await sql("SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'charge'", [u.id])).toHaveLength(1);
  });

  it('опрос интерфейса не плодит записей: меньше минуты работы не начисляется вообще', async () => {
    const u = await newUser(app, { balance: 2000 });
    const { id } = await launch(u, offer);
    for (let i = 0; i < 3; i++) expect((await u.api.get('/api/billing/balance')).body.charged).toBe('0.0000');
    await sql("UPDATE instances SET last_billed_at = now() - interval '30 seconds' WHERE id = $1", [id]);
    expect((await u.api.get('/api/billing/balance')).body.charged).toBe('0.0000');
    expect(await sql('SELECT 1 FROM usage_records WHERE user_id = $1', [u.id])).toHaveLength(0);
    await sql("UPDATE instances SET last_billed_at = now() - interval '90 seconds' WHERE id = $1", [id]);
    const res = await u.api.get('/api/billing/balance');
    expect(Number(res.body.charged)).toBeGreaterThan(hourly * 90 / 3600 * 0.99);
    expect(Number(res.body.charged)).toBeLessThan(hourly * 100 / 3600);
  });

  it('GET /instances тоже начисляет, а при нулевом балансе остановка видна сразу в этом же списке', async () => {
    const u = await newUser(app);
    await topUp(u.api, Math.ceil(hourly) + 1);
    const { id } = await launch(u, offer);
    await shiftBilling(id, '10 hours');

    const list = await u.api.get('/api/instances');
    expect(list.status).toBe(200);
    expect(list.body.find((i: { id: string }) => i.id === id).status).toBe('stopped');
    expect(Number(await balanceOf(u.id))).toBeLessThan(0);
    expect(await sql("SELECT 1 FROM audit_log WHERE action = 'instance.autostop_low_balance' AND entity_id = $1", [id])).toHaveLength(1);
    const open = await sql<{ n: number }>('SELECT count(*)::int AS n FROM instance_gpus WHERE instance_id = $1 AND upper_inf(allocated_during)', [id]);
    expect(open[0]!.n).toBe(0);
  });

  it('GET /instances/:id тоже сначала начисляет', async () => {
    const u = await newUser(app);
    await topUp(u.api, Math.ceil(hourly) + 1);
    const { id } = await launch(u, offer);
    await shiftBilling(id, '10 hours');
    const one = await u.api.get(`/api/instances/${id}`);
    expect(one.body.status).toBe('stopped');
  });

  it('обращение пользователя B не начисляет за инстанс пользователя A', async () => {
    const a = await newUser(app, { balance: 2000 });
    const b = await newUser(app, { balance: 100 });
    const { id } = await launch(a, offer);
    await shiftBilling(id, '3 hours');
    const [before] = await sql<{ t: Date }>('SELECT last_billed_at AS t FROM instances WHERE id = $1', [id]);

    for (const call of ['/api/billing/balance', '/api/instances']) expect((await b.api.get(call)).status).toBe(200);
    const [after] = await sql<{ t: Date }>('SELECT last_billed_at AS t FROM instances WHERE id = $1', [id]);
    expect(after!.t.getTime()).toBe(before!.t.getTime());
    expect(await balanceOf(a.id)).toBe('2000.0000');
    expect(await sql("SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'charge'", [b.id])).toHaveLength(0);
  });

  it('параллельные обращения одного пользователя начисляют один раз', async () => {
    const u = await newUser(app, { balance: 3000 });
    const { id } = await launch(u, offer);
    await shiftBilling(id, '2 hours');
    const results = await Promise.all(Array.from({ length: 6 }, () => u.api.get('/api/billing/balance')));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const total = results.reduce((sum, r) => sum + Number(r.body.charged), 0);
    expect(total).toBeGreaterThan(hourly * 2 * 0.999);
    expect(total).toBeLessThan(hourly * 2 * 1.01);
    expect(await sql("SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'charge'", [u.id])).toHaveLength(1);
  });

  it('хранение томов начисляется по тарифу ДЦ', async () => {
    const u = await newUser(app, { balance: 2000 });
    const created = await u.api.post('/api/volumes', { name: 'data', datacenterCode: offer.dc, sizeGb: 100 });
    expect(created.status).toBe(201);
    await sql("UPDATE volumes SET created_at = now() - interval '2 days', last_billed_at = now() - interval '1 day' WHERE id = $1", [created.body.id]);
    const [price] = await sql<{ p: string }>(
      'SELECT sp.price_per_gb_month AS p FROM storage_prices sp JOIN datacenters d ON d.id = sp.datacenter_id WHERE d.code = $1 AND sp.valid_during @> now()',
      [offer.dc],
    );
    const expected = (100 * Number(price!.p)) / 30; // ГБ × цена за ГБ-месяц × (1 сутки / 30)
    const res = await u.api.get('/api/billing/balance');
    expect(Number(res.body.charged)).toBeGreaterThan(expected * 0.999);
    expect(Number(res.body.charged)).toBeLessThan(expected * 1.005);
    const spend = await u.api.get('/api/billing/spend');
    expect(Number(spend.body.storage)).toBeCloseTo(Number(res.body.charged), 3);
  });

  it('без входа — 401', async () => {
    expect((await new Api(app).get('/api/billing/balance')).status).toBe(401);
    expect((await new Api(app).get('/api/billing/transactions')).status).toBe(401);
    expect((await new Api(app).get('/api/billing/spend')).status).toBe(401);
  });
});

describe('история операций: keyset-пагинация', () => {
  let u: TestUser;
  const amounts = [100, 200, 300, 400, 500, 600, 700];

  beforeAll(async () => {
    u = await newUser(app);
    for (const a of amounts) await topUp(u.api, a);
  });

  async function walk(limit: number): Promise<{ id: number; amount: string }[]> {
    const all: { id: number; amount: string }[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const res = await u.api.get(`/api/billing/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(limit);
      all.push(...res.body.items);
      cursor = res.body.nextCursor;
      if (!cursor) return all;
    }
    throw new Error('пагинация не закончилась');
  }

  it('форма элемента и порядок: новые сверху', async () => {
    const res = await u.api.get('/api/billing/transactions');
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items).toHaveLength(7);
    expect(res.body.items[0]).toEqual({ id: expect.any(Number), type: 'topup', amount: '700.0000', description: expect.any(String), createdAt: expect.any(String) });
    expect(res.body.items.map((t: { amount: string }) => Number(t.amount))).toEqual([...amounts].reverse());
  });

  it.each([1, 2, 3, 7, 100])('обход по limit=%i даёт все операции ровно один раз и в том же порядке', async (limit) => {
    const all = await walk(limit);
    expect(all).toHaveLength(7);
    expect(new Set(all.map((t) => t.id)).size).toBe(7);
    expect(all.map((t) => Number(t.amount))).toEqual([...amounts].reverse());
  });

  it('новые операции между запросами страниц не ломают обход (курсор привязан к позиции)', async () => {
    const first = await u.api.get('/api/billing/transactions?limit=3');
    await topUp(u.api, 800);
    const second = await u.api.get(`/api/billing/transactions?limit=10&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items.map((t: { amount: string }) => Number(t.amount))).toEqual([400, 300, 200, 100]);
    amounts.push(800);
  });

  it('некорректные курсор и limit — 400, а не 500', async () => {
    const forged = Buffer.from(JSON.stringify({ t: '2026-02-31T00:00:00.000000Z', id: 1 })).toString('base64url');
    const wrongType = Buffer.from(JSON.stringify({ t: 5, id: 'x' })).toString('base64url');
    const year0 = Buffer.from(JSON.stringify({ t: '0000-01-01T00:00:00.000000Z', id: 1 })).toString('base64url');
    for (const cursor of ['abc', '###', forged, year0, wrongType, Buffer.from('null').toString('base64url')]) {
      const res = await u.api.get(`/api/billing/transactions?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status, cursor).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURSOR');
    }
    for (const limit of ['0', '101', 'abc', '-1', '1.5']) expect((await u.api.get(`/api/billing/transactions?limit=${limit}`)).status, limit).toBe(400);
    expect((await u.api.get('/api/billing/transactions?cursor=a&cursor=b')).status).toBe(400);
  });

  it('чужой курсор не открывает чужих операций; администратор видит только свою историю', async () => {
    const first = await u.api.get('/api/billing/transactions?limit=2');
    const other = await newUser(app);
    const res = await other.api.get(`/api/billing/transactions?cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);

    const admin = await loginAs(app, ADMIN.email, ADMIN.password);
    const adminTx = await admin.get('/api/billing/transactions?limit=100');
    expect(adminTx.status).toBe(200);
    expect(adminTx.body.items).toEqual([]);
  });
});

describe('расходы /billing/spend', () => {
  it('итоги по дням и по инстансам сходятся с журналом операций', async () => {
    const u = await newUser(app, { balance: 3000 });
    const a = await launch(u, offer, { name: 'alpha' });
    const b = await launch(u, offer, { name: 'beta', gpuCount: 2 });
    await shiftBilling(a.id, '2 hours');
    await shiftBilling(b.id, '1 hour');
    const bal = await u.api.get('/api/billing/balance');
    const charged = Number(bal.body.charged);
    expect(charged).toBeGreaterThan(0);

    const res = await u.api.get('/api/billing/spend');
    expect(res.status).toBe(200);
    expect(res.body.to).toBe(moscowToday());
    expect(Number(res.body.total)).toBeCloseTo(charged, 3);
    expect(res.body.byDay.reduce((s: number, d: { amount: string }) => s + Number(d.amount), 0)).toBeCloseTo(charged, 3);
    const names = res.body.byInstance.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    const alpha = res.body.byInstance.find((i: { name: string }) => i.name === 'alpha');
    expect(alpha.instanceId).toBe(a.id);
    expect(Number(alpha.amount)).toBeGreaterThan(hourly * 2 * 0.99);
    // самый дорогой — первый
    expect(Number(res.body.byInstance[0].amount)).toBeGreaterThanOrEqual(Number(res.body.byInstance[1].amount));
    expect(res.body.byDay.map((d: { day: string }) => d.day)).toEqual([...res.body.byDay.map((d: { day: string }) => d.day)].sort());
  });

  it('другой пользователь видит нулевые расходы', async () => {
    const other = await newUser(app);
    const res = await other.api.get('/api/billing/spend');
    expect(res.body.total).toBe('0.0000');
    expect(res.body.byDay).toEqual([]);
    expect(res.body.byInstance).toEqual([]);
  });

  it('границы периода: по умолчанию 30 дней, максимум 366, from > to и несуществующие даты — 400', async () => {
    const u = await newUser(app);
    const def = await u.api.get('/api/billing/spend');
    const days = (Date.parse(`${def.body.to}T00:00:00Z`) - Date.parse(`${def.body.from}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(30);

    expect((await u.api.get('/api/billing/spend?from=2025-01-01&to=2025-12-31')).status).toBe(200); // 365 суток
    expect((await u.api.get('/api/billing/spend?from=2024-01-01&to=2024-12-31')).status).toBe(200); // 366 суток, високосный год
    expect((await u.api.get('/api/billing/spend?from=2025-01-01&to=2026-01-02')).status).toBe(400); // 367
    expect((await u.api.get('/api/billing/spend?from=2025-05-02&to=2025-05-01')).status).toBe(400);
    expect((await u.api.get('/api/billing/spend?from=2025-02-31&to=2025-03-01')).status).toBe(400);
    expect((await u.api.get('/api/billing/spend?from=0000-01-01&to=0000-01-02')).status).toBe(400); // года 0000 в PostgreSQL нет
    expect((await u.api.get('/api/billing/spend?to=0001-01-10')).status).toBe(400); // from по умолчанию ушёл бы в год 0000
    expect((await u.api.get('/api/billing/spend?from=abc')).status).toBe(400);
    expect((await u.api.get('/api/billing/spend?from=2025-01-01&from=2025-01-02')).status).toBe(400);
  });
});

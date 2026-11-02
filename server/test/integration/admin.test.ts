import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, CRON_SECRET, closeAll, launch, loginAs, makeApp, newUser, pickOffer, bare, sql } from './helpers';
import type { Offer, TestUser } from './helpers';

const app = makeApp();
let admin: Api;
let client: TestUser;
let offer: Offer;

beforeAll(async () => {
  admin = await loginAs(app, ADMIN.email, ADMIN.password);
  client = await newUser(app, { balance: 5000 });
  offer = await pickOffer(app, 8);
});
afterAll(closeAll);

const ADMIN_GET = ['/api/admin/dashboard', '/api/admin/prices', '/api/admin/prices/storage', '/api/admin/infrastructure', '/api/admin/users', '/api/admin/audit'];
const ADMIN_POST: [string, object | undefined][] = [
  ['/api/admin/prices', { datacenterCode: 'MSK-1', gpuModel: 'RTX 4090', pricingType: 'spot', pricePerHour: 50 }],
  ['/api/admin/gpus/1/disable', undefined],
  ['/api/admin/gpus/1/enable', undefined],
  ['/api/admin/nodes/1/status', { status: 'maintenance' }],
  ['/api/admin/users/2/block', undefined],
  ['/api/admin/users/2/unblock', undefined],
];

describe('доступ только для администратора', () => {
  it.each(ADMIN_GET)('GET %s: аноним 401, клиент 403, клиент по API-ключу 403, администратор 200', async (url) => {
    expect((await new Api(app).get(url)).status).toBe(401);
    const asClient = await client.api.get(url);
    expect(asClient.status).toBe(403);
    expect(asClient.body.error.code).toBe('FORBIDDEN');
    expect((await admin.get(url)).status).toBe(200);
  });

  it.each(ADMIN_POST)('POST %s: аноним 401, клиент 403, ничего не меняется', async (url, body) => {
    expect((await new Api(app).post(url, body)).status).toBe(401);
    const asClient = await client.api.post(url, body);
    expect(asClient.status).toBe(403);
    expect(asClient.body.error.code).toBe('FORBIDDEN');
  });

  it('клиент с API-ключом тоже получает 403', async () => {
    const key = await client.api.post('/api/api-keys', { name: 'bot' });
    const bot = new Api(app);
    bot.bearer = key.body.key;
    for (const url of ADMIN_GET) expect((await bot.get(url)).status, url).toBe(403);
    for (const [url, body] of ADMIN_POST) expect((await bot.post(url, body, { csrf: false })).status, url).toBe(403);
  });

  it('неизвестный адрес в /api/admin: клиент видит 403 (не узнаёт, что там есть), администратор — 404', async () => {
    expect((await client.api.get('/api/admin/nothing')).status).toBe(403);
    expect((await admin.get('/api/admin/nothing')).status).toBe(404);
  });

  it('клиент не может менять данные админских эндпоинтов, даже если угадал параметры: цены и блокировки не изменились', async () => {
    const before = await sql<{ n: number }>('SELECT count(*)::int AS n FROM gpu_prices');
    await client.api.post('/api/admin/prices', { datacenterCode: offer.dc, gpuModel: offer.model, pricingType: 'on_demand', pricePerHour: 1 });
    await client.api.post(`/api/admin/users/${client.id}/block`);
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM gpu_prices'))[0]!.n).toBe(before[0]!.n);
    expect((await client.api.get('/api/auth/me')).status).toBe(200);
  });

  it('изменяющие админские запросы требуют CSRF-заголовков и сессии', async () => {
    const noHeader = await admin.post('/api/admin/gpus/1/disable', undefined, { csrf: false });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF');
  });
});

describe('цены', () => {
  it('новая цена закрывает действующую и открывает новую в одной транзакции: без разрыва и пересечения', async () => {
    const dc = offer.dc;
    const key = `datacenter_id = (SELECT id FROM datacenters WHERE code = '${dc}') AND gpu_model_id = (SELECT id FROM gpu_models WHERE name = '${offer.model}') AND pricing_type = 'on_demand'`;
    const periods = () => sql<{ id: number; price: string; lo: Date; hi: Date | null }>(
      `SELECT id, price_per_hour AS price, lower(valid_during) AS lo, upper(valid_during) AS hi FROM gpu_prices WHERE ${key} ORDER BY lower(valid_during)`,
    );
    const before = await periods();
    const old = before[before.length - 1]!;
    expect(old.hi).toBeNull();
    const newPrice = (Number(old.price) + 3.5).toFixed(4);

    const res = await admin.post('/api/admin/prices', { datacenterCode: dc, gpuModel: offer.model, pricingType: 'on_demand', pricePerHour: Number(newPrice) });
    expect(res.status).toBe(201);
    expect(res.body.changed).toBe(true);
    expect(res.body.price).toMatchObject({ datacenter: { code: dc }, gpuModel: offer.model, pricingType: 'on_demand', pricePerHour: newPrice, validTo: null });

    const after = await periods();
    expect(after).toHaveLength(before.length + 1);
    const closed = after.find((p) => p.id === old.id)!;
    const opened = after[after.length - 1]!;
    expect(closed.hi).not.toBeNull();
    expect(opened.id).not.toBe(old.id);
    expect(opened.hi).toBeNull();
    expect(opened.lo.getTime()).toBe(closed.hi!.getTime()); // старая закрыта ровно в момент открытия новой
    expect(after.filter((p) => p.hi === null)).toHaveLength(1);

    // каталог показывает новую цену
    const catalog = await bare(app).get('/api/catalog/gpus');
    const row = catalog.body.find((r: { datacenter: { code: string }; model: { name: string } }) => r.datacenter.code === dc && r.model.name === offer.model);
    expect(row.priceOnDemand).toBe(newPrice);

    // журнал: закрытие и открытие
    const audit = await sql<{ action: string }>("SELECT action FROM audit_log WHERE entity = 'gpu_prices' AND entity_id IN ($1, $2) ORDER BY id", [String(old.id), String(opened.id)]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['gpu_price.update', 'gpu_price.insert']));

    // в истории цен администратора видны оба периода
    const history = await admin.get('/api/admin/prices');
    const ids = history.body.map((p: { id: number }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([old.id, opened.id]));
    expect(history.body.find((p: { id: number }) => p.id === old.id).validTo).not.toBeNull();
    expect(history.body.find((p: { id: number }) => p.id === opened.id).validTo).toBeNull();
  });

  it('идущий инстанс сохраняет старую цену (снимок), новый запускается по новой', async () => {
    const u = await newUser(app, { balance: 20_000 });
    const first = await launch(u, offer);
    const oldPrice = first.body.pricePerHour;
    const bumped = (Number(oldPrice) + 10).toFixed(4);
    expect((await admin.post('/api/admin/prices', { datacenterCode: offer.dc, gpuModel: offer.model, pricingType: 'on_demand', pricePerHour: Number(bumped) })).status).toBe(201);
    expect((await u.api.get(`/api/instances/${first.id}`)).body.pricePerHour).toBe(oldPrice);
    const second = await launch(u, offer);
    expect(second.body.pricePerHour).toBe(bumped);
  });

  it('та же цена повторно: 200 changed:false, история не растёт, в журнал ничего не пишется', async () => {
    const current = (await bare(app).get('/api/catalog/gpus')).body.find(
      (r: { datacenter: { code: string }; model: { name: string } }) => r.datacenter.code === offer.dc && r.model.name === offer.model,
    ).priceSpot as string;
    const countPrices = async () => (await sql<{ n: number }>('SELECT count(*)::int AS n FROM gpu_prices'))[0]!.n;
    const countAudit = async () => (await sql<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity = 'gpu_prices'"))[0]!.n;
    const [prices, audits] = [await countPrices(), await countAudit()];
    const res = await admin.post('/api/admin/prices', { datacenterCode: offer.dc, gpuModel: offer.model, pricingType: 'spot', pricePerHour: current });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(await countPrices()).toBe(prices);
    expect(await countAudit()).toBe(audits);
  });

  it('два одновременных изменения цены применяются по очереди: открытый период один, пересечений нет', async () => {
    const other = await loginAs(app, ADMIN.email, ADMIN.password);
    const body = (p: number) => ({ datacenterCode: offer.dc, gpuModel: offer.model, pricingType: 'spot', pricePerHour: p });
    for (let round = 0; round < 5; round++) {
      const [r1, r2] = await Promise.all([admin.post('/api/admin/prices', body(61.1 + round)), other.post('/api/admin/prices', body(62.2 + round))]);
      expect([r1.status, r2.status].sort(), `раунд ${round}`).toEqual([201, 201]);
    }
    const open = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM gpu_prices WHERE upper_inf(valid_during) AND pricing_type = 'spot'
         AND datacenter_id = (SELECT id FROM datacenters WHERE code = $1) AND gpu_model_id = (SELECT id FROM gpu_models WHERE name = $2)`,
      [offer.dc, offer.model],
    );
    expect(open[0]!.n).toBe(1);
  });

  it('проверка входных данных и объектов', async () => {
    const good = { datacenterCode: offer.dc, gpuModel: offer.model, pricingType: 'spot', pricePerHour: 40 };
    for (const bad of [{ pricePerHour: -5 }, { pricePerHour: 0 }, { pricePerHour: 10.12345 }, { pricePerHour: 'много' }, { pricingType: 'free' }, { id: 5 }, { validFrom: '2020-01-01' }]) {
      const res = await admin.post('/api/admin/prices', { ...good, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await admin.post('/api/admin/prices', { ...good, datacenterCode: 'XXX-9' })).status).toBe(404);
    expect((await admin.post('/api/admin/prices', { ...good, gpuModel: 'Нет такой' })).status).toBe(404);
  });

  it('цены хранения доступны для чтения', async () => {
    const res = await admin.get('/api/admin/prices/storage');
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    expect(res.body[0]).toEqual({ id: expect.any(Number), datacenter: { code: expect.any(String), name: expect.any(String) }, pricePerGbMonth: expect.any(String), validFrom: expect.any(String), validTo: null });
  });
});

describe('панель, инфраструктура, пользователи, журнал', () => {
  it('дашборд: ряд по дням без пропусков, итоги сходятся с витриной выручки, загрузка — с каталогом', async () => {
    await bare(app).post('/api/internal/billing').set('Authorization', `Bearer ${CRON_SECRET}`); // обновляет витрину
    // период берём от сегодняшнего дня: история seed лежит в последних 90 сутках
    const dayAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const [from, to] = [dayAgo(20), dayAgo(7)];
    const res = await admin.get(`/api/admin/dashboard?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.revenueByDay).toHaveLength(14);
    expect(res.body.revenueByDay.map((d: { day: string }) => d.day)).toEqual(Array.from({ length: 14 }, (_, i) => dayAgo(20 - i)));
    const [mv] = await sql<{ revenue: string; hours: string }>('SELECT coalesce(sum(revenue), 0) AS revenue, coalesce(sum(gpu_hours), 0) AS hours FROM mv_daily_revenue WHERE day BETWEEN $1 AND $2', [from, to]);
    const sumDays = res.body.revenueByDay.reduce((s: number, d: { revenue: string }) => s + Number(d.revenue), 0);
    expect(sumDays).toBeCloseTo(Number(mv!.revenue), 3);
    expect(Number(res.body.period.revenue)).toBeCloseTo(Number(mv!.revenue), 3);
    expect(sumDays).toBeGreaterThan(0);
    expect(res.body.revenueByDatacenter.reduce((s: number, d: { revenue: string }) => s + Number(d.revenue), 0)).toBeCloseTo(sumDays, 3);
    expect(res.body.revenueByModel.reduce((s: number, d: { revenue: string }) => s + Number(d.revenue), 0)).toBeCloseTo(sumDays, 3);

    const u = res.body.utilization;
    const [gpus] = await sql<{ total: number; busy: number; disabled: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM instance_gpus ig WHERE ig.gpu_id = g.id AND upper_inf(ig.allocated_during)))::int AS busy,
              count(*) FILTER (WHERE NOT g.is_enabled)::int AS disabled FROM gpus g`,
    );
    expect(u).toEqual({ total: gpus!.total, busy: gpus!.busy, free: expect.any(Number), disabled: gpus!.disabled });
    const catalogFree = (await bare(app).get('/api/catalog/gpus')).body.reduce((s: number, r: { free: number }) => s + r.free, 0);
    expect(u.free).toBe(catalogFree);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('дашборд: неверный период — 400', async () => {
    for (const q of ['from=2026-02-31&to=2026-03-01', 'from=2026-10-10&to=2026-10-01', 'from=2024-01-01&to=2026-01-01', 'from=abc', 'from=0000-01-01&to=0000-01-02']) {
      expect((await admin.get(`/api/admin/dashboard?${q}`)).status, q).toBe(400);
    }
  });

  it('инфраструктура: ДЦ -> ноды -> GPU; выключенная GPU уходит из «свободных» в каталоге и возвращается', async () => {
    const infra = await admin.get('/api/admin/infrastructure');
    expect(infra.body).toHaveLength(4);
    const dc = infra.body.find((d: { code: string }) => d.code === offer.dc);
    const node = dc.nodes.find((n: { status: string; gpus: { busy: boolean; isEnabled: boolean; model: string }[] }) => n.status === 'online' && n.gpus.some((g) => !g.busy && g.isEnabled && g.model === offer.model));
    const gpu = node.gpus.find((g: { busy: boolean; isEnabled: boolean; model: string }) => !g.busy && g.isEnabled && g.model === offer.model);
    expect(gpu).toEqual({ id: expect.any(Number), slot: expect.any(Number), serial: expect.any(String), model: offer.model, isEnabled: true, busy: false });

    const freeNow = async () => (await bare(app).get('/api/catalog/gpus')).body.find((r: { datacenter: { code: string }; model: { name: string } }) => r.datacenter.code === offer.dc && r.model.name === offer.model).free as number;
    const free0 = await freeNow();
    const off = await admin.post(`/api/admin/gpus/${gpu.id}/disable`);
    expect(off.body).toEqual({ id: gpu.id, isEnabled: false, changed: true });
    expect(await freeNow()).toBe(free0 - 1);
    expect((await admin.post(`/api/admin/gpus/${gpu.id}/disable`)).body.changed).toBe(false);
    expect((await admin.post(`/api/admin/gpus/${gpu.id}/enable`)).body).toEqual({ id: gpu.id, isEnabled: true, changed: true });
    expect(await freeNow()).toBe(free0);
    expect((await sql("SELECT 1 FROM audit_log WHERE action IN ('gpu.disabled', 'gpu.enabled') AND entity_id = $1", [String(gpu.id)])).length).toBe(2);
    expect((await admin.post('/api/admin/gpus/99999999/disable')).status).toBe(404);
  });

  it('узел на обслуживании не даёт запускать инстансы; после возврата в online запуск снова возможен', async () => {
    const scarce = await pickOffer(app, 1, 3);
    const infra = await admin.get('/api/admin/infrastructure');
    const dc = infra.body.find((d: { code: string }) => d.code === scarce.dc);
    const nodes = dc.nodes.filter((n: { status: string; gpus: { model: string }[] }) => n.status === 'online' && n.gpus.some((g) => g.model === scarce.model));
    const freeNow = async () => (await bare(app).get('/api/catalog/gpus')).body.find((r: { datacenter: { code: string }; model: { name: string } }) => r.datacenter.code === scarce.dc && r.model.name === scarce.model).free as number;
    const free0 = await freeNow();
    for (const n of nodes) expect((await admin.post(`/api/admin/nodes/${n.id}/status`, { status: 'maintenance' })).status).toBe(200);
    expect(await freeNow()).toBe(0);
    const u = await newUser(app, { balance: 5000 });
    const blocked = await u.api.post('/api/instances', { name: 'x', datacenterCode: scarce.dc, gpuModel: scarce.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1 });
    expect(blocked.status).toBe(409);
    for (const n of nodes) await admin.post(`/api/admin/nodes/${n.id}/status`, { status: 'online' });
    expect(await freeNow()).toBe(free0);
    expect((await admin.post('/api/admin/nodes/1/status', { status: 'broken' })).status).toBe(400);
    expect((await admin.post('/api/admin/nodes/99999999/status', { status: 'online' })).status).toBe(404);
  });

  it('пользователи: список без хэшей паролей, поиск, постраничность, общее число в заголовке', async () => {
    const all = await admin.get('/api/admin/users?limit=5');
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(5);
    expect(Number(all.headers['x-total-count'])).toBeGreaterThan(50);
    expect(Object.keys(all.body[0]).sort()).toEqual(['balance', 'createdAt', 'email', 'emailVerified', 'fullName', 'id', 'role', 'status']);
    expect(JSON.stringify(all.body)).not.toMatch(/\$2[aby]\$|password|hash/i);

    const found = await admin.get(`/api/admin/users?q=${encodeURIComponent(client.email)}`);
    expect(found.body.map((u: { id: number }) => u.id)).toEqual([client.id]);
    const page2 = await admin.get('/api/admin/users?limit=5&offset=5');
    expect(page2.body.map((u: { id: number }) => u.id)).not.toEqual(expect.arrayContaining(all.body.map((u: { id: number }) => u.id)));
    expect((await admin.get('/api/admin/users?limit=500')).status).toBe(400);
    expect((await admin.get('/api/admin/users?offset=-1')).status).toBe(400);
  });

  it('поиск пользователей: символы LIKE и кавычки трактуются буквально', async () => {
    for (const q of ['%', '_', "' OR '1'='1", '"; DROP TABLE users; --', '\\']) {
      const res = await admin.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
      expect(res.body, q).toEqual([]);
    }
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM users'))[0]!.n).toBeGreaterThan(50);
  });

  it('журнал аудита: страницы по убыванию id без повторов, курсор проверяется', async () => {
    const seen: { id: number; action: string; entity: string; actor: unknown; ip: unknown; createdAt: string }[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const res = await admin.get(`/api/admin/audit?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    const total = (await sql<{ n: number }>('SELECT count(*)::int AS n FROM audit_log'))[0]!.n;
    expect(seen).toHaveLength(total);
    expect(new Set(seen.map((e) => e.id)).size).toBe(total);
    const ids = seen.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    expect(seen[0]).toEqual({
      id: expect.any(Number), action: expect.any(String), entity: expect.any(String), entityId: expect.anything(), actor: expect.anything(), details: expect.any(Object), ip: expect.anything(), createdAt: expect.any(String),
    });
    for (const bad of ['abc', Buffer.from('{"id":"x"}').toString('base64url'), Buffer.from('{"id":-1}').toString('base64url')]) {
      expect((await admin.get(`/api/admin/audit?cursor=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
    const huge = Buffer.from('{"id":99999999999999999999}').toString('base64url');
    expect((await admin.get(`/api/admin/audit?cursor=${encodeURIComponent(huge)}`)).status).toBe(400);
    expect((await admin.get('/api/admin/audit?limit=0')).status).toBe(400);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, balanceOf, closeAll, launch, loginAs, makeApp, newUser, pickOffer, sql } from './helpers';
import type { Offer, TestUser } from './helpers';

const app = makeApp();
let offer: Offer;
let otherDc: string;
let user: TestUser;

beforeAll(async () => {
  offer = await pickOffer(app, 8);
  const dcs = await sql<{ code: string }>('SELECT code FROM datacenters WHERE is_active AND code <> $1 ORDER BY code', [offer.dc]);
  otherDc = dcs[0]!.code;
  user = await newUser(app, { balance: 20_000 });
});
afterAll(closeAll);

const newVolume = async (u: TestUser, over: Record<string, unknown> = {}) => {
  const res = await u.api.post('/api/volumes', { name: `vol-${Math.random().toString(36).slice(2, 8)}`, datacenterCode: offer.dc, sizeGb: 100, ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; name: string; sizeGb: number };
};

describe('создание и список', () => {
  it('201: форма ответа, том свободен и активен', async () => {
    const res = await user.api.post('/api/volumes', { name: 'datasets', datacenterCode: offer.dc, sizeGb: 200 });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      id: expect.any(Number),
      name: 'datasets',
      sizeGb: 200,
      datacenter: { code: offer.dc, name: expect.any(String) },
      status: 'active',
      attachedTo: null,
      createdAt: expect.any(String),
    });
  });

  it('в списке только свои активные тома, новые сверху', async () => {
    const u = await newUser(app);
    const one = await newVolume(u, { name: 'one' });
    const two = await newVolume(u, { name: 'two' });
    await u.api.delete(`/api/volumes/${one.id}`);
    const list = await u.api.get('/api/volumes');
    expect(list.body.map((v: { name: string }) => v.name)).toEqual(['two']);
    expect(list.body[0].id).toBe(two.id);
  });

  it('владелец и датацентр не берутся из тела: лишние поля — 400', async () => {
    const victim = await newUser(app);
    for (const extra of [{ userId: victim.id }, { status: 'deleted' }, { datacenterId: 1 }]) {
      const res = await user.api.post('/api/volumes', { name: 'x', datacenterCode: offer.dc, sizeGb: 10, ...extra });
      expect(res.status).toBe(400);
    }
    expect(await sql('SELECT 1 FROM volumes WHERE user_id = $1', [victim.id])).toHaveLength(0);
  });

  it('размер 10..10000 ГБ, целый; неизвестный ДЦ — 404', async () => {
    for (const sizeGb of [9, 10_001, 100.5, '100', 0, -10]) {
      expect((await user.api.post('/api/volumes', { name: 'x', datacenterCode: offer.dc, sizeGb })).status, `размер ${sizeGb}`).toBe(400);
    }
    expect((await user.api.post('/api/volumes', { name: 'x', datacenterCode: 'XXX-9', sizeGb: 10 })).status).toBe(404);
    expect((await user.api.post('/api/volumes', { name: '', datacenterCode: offer.dc, sizeGb: 10 })).status).toBe(400);
  });

  it('без входа — 401', async () => {
    expect((await new Api(app).get('/api/volumes')).status).toBe(401);
    expect((await new Api(app).post('/api/volumes', { name: 'x', datacenterCode: offer.dc, sizeGb: 10 })).status).toBe(401);
  });

  it('администратор видит только свои тома', async () => {
    const admin = await loginAs(app, ADMIN.email, ADMIN.password);
    const mine = await newVolume(user);
    const list = await admin.get('/api/volumes');
    expect(list.status).toBe(200);
    expect(list.body.find((v: { id: number }) => v.id === mine.id)).toBeUndefined();
  });
});

describe('расширение', () => {
  it('sizeGb — новый общий размер: увеличить можно, уменьшить нельзя', async () => {
    const v = await newVolume(user, { sizeGb: 100 });
    const up = await user.api.post(`/api/volumes/${v.id}/extend`, { sizeGb: 150 });
    expect(up.status).toBe(200);
    expect(up.body.sizeGb).toBe(150);
    expect((await user.api.get('/api/volumes')).body.find((x: { id: number }) => x.id === v.id).sizeGb).toBe(150);

    const down = await user.api.post(`/api/volumes/${v.id}/extend`, { sizeGb: 120 });
    expect(down.status).toBe(409);
    expect(down.body.error.code).toBe('INVALID_STATE');
    expect(down.body.error.message).toMatch(/увеличивать/);
    const [row] = await sql<{ size_gb: number }>('SELECT size_gb FROM volumes WHERE id = $1', [v.id]);
    expect(row!.size_gb).toBe(150);
  });

  it('новый размер не применяется задним числом: хранение до расширения начисляется по старому размеру', async () => {
    const u = await newUser(app, { balance: 5000 });
    const v = await newVolume(u, { sizeGb: 100 });
    await sql("UPDATE volumes SET created_at = now() - interval '2 days', last_billed_at = now() - interval '1 day' WHERE id = $1", [v.id]);
    const [price] = await sql<{ p: string }>(
      'SELECT sp.price_per_gb_month AS p FROM storage_prices sp JOIN datacenters d ON d.id = sp.datacenter_id WHERE d.code = $1 AND sp.valid_during @> now()',
      [offer.dc],
    );
    const before = Number(await balanceOf(u.id));
    expect((await u.api.post(`/api/volumes/${v.id}/extend`, { sizeGb: 1000 })).status).toBe(200);
    const charged = before - Number(await balanceOf(u.id));
    const oldSize = (100 * Number(price!.p)) / 30;
    expect(charged).toBeGreaterThan(oldSize * 0.999);
    expect(charged).toBeLessThan(oldSize * 1.005); // по 100 ГБ, а не по 1000
  });

  it('границы размера и лишние поля', async () => {
    const v = await newVolume(user);
    expect((await user.api.post(`/api/volumes/${v.id}/extend`, { sizeGb: 10_001 })).status).toBe(400);
    expect((await user.api.post(`/api/volumes/${v.id}/extend`, { sizeGb: 'много' })).status).toBe(400);
    expect((await user.api.post(`/api/volumes/${v.id}/extend`, { sizeGb: 500, name: 'renamed' })).status).toBe(400);
    expect((await user.api.post('/api/volumes/abc/extend', { sizeGb: 500 })).status).toBe(400);
    expect((await user.api.post('/api/volumes/99999999/extend', { sizeGb: 500 })).status).toBe(404);
  });
});

describe('подключение к инстансу и удаление', () => {
  it('том подключается при запуске; один том — один живой инстанс', async () => {
    const v = await newVolume(user);
    const run = await launch(user, offer, { volumeId: v.id });
    expect(run.body.volume).toEqual({ id: v.id, name: v.name, sizeGb: 100 });
    const listed = (await user.api.get('/api/volumes')).body.find((x: { id: number }) => x.id === v.id);
    expect(listed.attachedTo).toEqual({ id: run.id, name: run.body.name });

    const second = await user.api.post('/api/instances', {
      name: 'second', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1, volumeId: v.id,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('INVALID_STATE');
  });

  it('подключённый том удалить нельзя — ни к работающему, ни к остановленному инстансу; после завершения можно', async () => {
    const v = await newVolume(user);
    const run = await launch(user, offer, { volumeId: v.id });
    const busy = await user.api.delete(`/api/volumes/${v.id}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('INVALID_STATE');

    await user.api.post(`/api/instances/${run.id}/stop`);
    expect((await user.api.delete(`/api/volumes/${v.id}`)).status).toBe(409);
    expect((await user.api.get('/api/volumes')).body.find((x: { id: number }) => x.id === v.id).attachedTo).not.toBeNull();

    await user.api.post(`/api/instances/${run.id}/terminate`);
    expect((await user.api.get('/api/volumes')).body.find((x: { id: number }) => x.id === v.id).attachedTo).toBeNull();
    expect((await user.api.delete(`/api/volumes/${v.id}`)).status).toBe(204);
  });

  it('удалённый том: в списке нет, повторное удаление и расширение — 404, в БД он помечен deleted (история хранится)', async () => {
    const v = await newVolume(user);
    expect((await user.api.delete(`/api/volumes/${v.id}`)).status).toBe(204);
    expect((await user.api.get('/api/volumes')).body.find((x: { id: number }) => x.id === v.id)).toBeUndefined();
    expect((await user.api.delete(`/api/volumes/${v.id}`)).status).toBe(404);
    expect((await user.api.post(`/api/volumes/${v.id}/extend`, { sizeGb: 500 })).status).toBe(404);
    const [row] = await sql<{ status: string; deleted_at: Date | null }>('SELECT status, deleted_at FROM volumes WHERE id = $1', [v.id]);
    expect(row!.status).toBe('deleted');
    expect(row!.deleted_at).not.toBeNull();
    // удалённый том нельзя подключить
    const res = await user.api.post('/api/instances', {
      name: 'x', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1, volumeId: v.id,
    });
    expect(res.status).toBe(404);
  });

  it('том из другого дата-центра подключить нельзя — 422 CONSISTENCY', async () => {
    const v = await newVolume(user, { datacenterCode: otherDc });
    const res = await user.api.post('/api/instances', {
      name: 'x', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1, volumeId: v.id,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONSISTENCY');
  });
});

describe('ограничения на аккаунт', () => {
  it('не более 10 томов: одиннадцатый — 409 LIMIT_REACHED; удалённый том место освобождает', async () => {
    const u = await newUser(app);
    const created: { id: number }[] = [];
    for (let i = 0; i < 10; i++) created.push(await newVolume(u, { sizeGb: 10 }));
    const over = await u.api.post('/api/volumes', { name: 'extra', datacenterCode: offer.dc, sizeGb: 10 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('LIMIT_REACHED');

    expect((await u.api.delete(`/api/volumes/${created[0]!.id}`)).status).toBe(204);
    expect((await u.api.post('/api/volumes', { name: 'again', datacenterCode: offer.dc, sizeGb: 10 })).status).toBe(201);
  });

  it('суммарный размер активных томов — не более 5000 ГБ', async () => {
    const u = await newUser(app);
    await newVolume(u, { sizeGb: 4000 });
    const over = await u.api.post('/api/volumes', { name: 'big', datacenterCode: offer.dc, sizeGb: 1001 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('LIMIT_REACHED');
    expect((await u.api.post('/api/volumes', { name: 'fit', datacenterCode: offer.dc, sizeGb: 1000 })).status).toBe(201);
  });

  it('расширение тома не обходит суммарный лимит 5000 ГБ; чужой и несуществующий том по-прежнему 404', async () => {
    const u = await newUser(app);
    const a = await newVolume(u, { sizeGb: 4000 });
    const b = await newVolume(u, { sizeGb: 10 });
    const over = await u.api.post(`/api/volumes/${b.id}/extend`, { sizeGb: 1001 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('LIMIT_REACHED');
    expect((await u.api.post(`/api/volumes/${b.id}/extend`, { sizeGb: 1000 })).status).toBe(200);
    expect((await u.api.post(`/api/volumes/${a.id}/extend`, { sizeGb: 4001 })).status).toBe(409);
    expect((await u.api.post('/api/volumes/999999999/extend', { sizeGb: 20 })).status).toBe(404);
    const stranger = await newUser(app);
    expect((await stranger.api.post(`/api/volumes/${a.id}/extend`, { sizeGb: 20 })).status).toBe(404);
  });

  it('параллельные запросы вместе не перешагивают лимит', async () => {
    const u = await newUser(app);
    for (let i = 0; i < 8; i++) await newVolume(u, { sizeGb: 10 });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => u.api.post('/api/volumes', { name: `race-${i}`, datacenterCode: offer.dc, sizeGb: 10 })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const n = (await sql<{ n: number }>("SELECT count(*)::int AS n FROM volumes WHERE user_id = $1 AND status = 'active'", [u.id]))[0]!.n;
    expect(n).toBe(10);
  });
});

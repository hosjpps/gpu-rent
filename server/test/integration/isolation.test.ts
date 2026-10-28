import type { Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSshKey } from '../support/ssh';
import { ADMIN, Api, balanceOf, closeAll, launch, loginAs, makeApp, newUser, pickOffer, sql, topUp } from './helpers';
import type { Offer, TestUser } from './helpers';

const app = makeApp();
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';
const MISSING_ID = 99_999_999;

let offer: Offer;
let a: TestUser; // владелец ресурсов
let b: TestUser; // посторонний
let inst: string;
let volumeId: number;
let sshKeyId: number;
let apiKeyId: number;
let templateId: number;
let paymentId: number;

beforeAll(async () => {
  offer = await pickOffer(app, 8);
  a = await newUser(app, { balance: 5000 });
  b = await newUser(app, { balance: 5000 });
  volumeId = (await a.api.post('/api/volumes', { name: 'a-vol', datacenterCode: offer.dc, sizeGb: 50 })).body.id;
  sshKeyId = (await a.api.post('/api/ssh-keys', { name: 'a-key', publicKey: makeSshKey().publicKey })).body.id;
  apiKeyId = (await a.api.post('/api/api-keys', { name: 'a-api' })).body.apiKey.id;
  templateId = (await a.api.post('/api/templates', { name: 'a-tpl', dockerImage: 'registry.example.com/a/env:1', defaultDiskGb: 20 })).body.id;
  inst = (await launch(a, offer, { name: 'a-instance' })).id;
  const payment = await a.api.post('/api/payments', { amount: 200 });
  paymentId = payment.body.payment.id;
});
afterAll(closeAll);

/** Ответ на чужой ресурс не должен отличаться от ответа на несуществующий: иначе по нему можно перебирать чужие id. */
async function expectSameAsMissing(foreign: () => Test, missing: () => Test, status: number): Promise<void> {
  // по очереди: запросы одного агента supertest делят сервер, который закрывается после первого ответа
  const f = await foreign();
  const m = await missing();
  expect(f.status).toBe(status);
  expect(m.status).toBe(status);
  expect(f.body).toEqual(m.body);
}

describe('чужие инстансы', () => {
  it('в списке и по id их нет; просмотр и управление — 404, как у несуществующих', async () => {
    const list = await b.api.get('/api/instances');
    expect(list.body).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain(inst);

    await expectSameAsMissing(() => b.api.get(`/api/instances/${inst}`), () => b.api.get(`/api/instances/${MISSING_UUID}`), 404);
    for (const action of ['stop', 'resume', 'terminate']) {
      await expectSameAsMissing(() => b.api.post(`/api/instances/${inst}/${action}`), () => b.api.post(`/api/instances/${MISSING_UUID}/${action}`), 404);
    }
    // инстанс жив и GPU по-прежнему заняты
    const mine = await a.api.get(`/api/instances/${inst}`);
    expect(mine.body.status).toBe('running');
    const open = await sql<{ n: number }>('SELECT count(*)::int AS n FROM instance_gpus WHERE instance_id = $1 AND upper_inf(allocated_during)', [inst]);
    expect(open[0]!.n).toBe(1);
  });

  it('параметры запроса не подменяют владельца: ?userId=, ?user_id=, ?owner=', async () => {
    for (const q of [`userId=${a.id}`, `user_id=${a.id}`, `owner=${a.id}`, `all=1&userId=${a.id}`]) {
      const res = await b.api.get(`/api/instances?${q}`);
      expect(res.body.every((i: { id: string }) => i.id !== inst), q).toBe(true);
    }
  });

  it('свой инстанс виден владельцу и по-прежнему управляется им', async () => {
    expect((await a.api.get(`/api/instances/${inst}`)).status).toBe(200);
  });

  it('?all=1 открывает чужие инстансы только администратору (с полем owner)', async () => {
    expect((await b.api.get('/api/instances?all=1')).body.some((i: { id: string }) => i.id === inst)).toBe(false);
    const admin = await loginAs(app, ADMIN.email, ADMIN.password);
    const all = await admin.get('/api/instances?all=1');
    const found = all.body.find((i: { id: string }) => i.id === inst);
    expect(found.owner).toEqual({ id: a.id, email: a.email });
    expect((await admin.get('/api/instances')).body.some((i: { id: string }) => i.id === inst)).toBe(false); // без all — только свои
  });
});

describe('чужие тома, ключи, шаблоны', () => {
  it('тома: не видны, расширение и удаление — 404 как у несуществующих; подключить к своему инстансу нельзя', async () => {
    expect((await b.api.get('/api/volumes')).body).toEqual([]);
    await expectSameAsMissing(() => b.api.post(`/api/volumes/${volumeId}/extend`, { sizeGb: 500 }), () => b.api.post(`/api/volumes/${MISSING_ID}/extend`, { sizeGb: 500 }), 404);
    await expectSameAsMissing(() => b.api.delete(`/api/volumes/${volumeId}`), () => b.api.delete(`/api/volumes/${MISSING_ID}`), 404);

    const launchWith = (id: number) => b.api.post('/api/instances', { name: 'x', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1, volumeId: id });
    await expectSameAsMissing(() => launchWith(volumeId), () => launchWith(MISSING_ID), 404);
    const [vol] = await sql<{ size_gb: number; status: string }>('SELECT size_gb, status FROM volumes WHERE id = $1', [volumeId]);
    expect(vol).toEqual({ size_gb: 50, status: 'active' });
  });

  it('SSH-ключи: не видны, удаление — 404', async () => {
    expect((await b.api.get('/api/ssh-keys')).body).toEqual([]);
    await expectSameAsMissing(() => b.api.delete(`/api/ssh-keys/${sshKeyId}`), () => b.api.delete(`/api/ssh-keys/${MISSING_ID}`), 404);
    expect(await sql('SELECT 1 FROM ssh_keys WHERE id = $1', [sshKeyId])).toHaveLength(1);
  });

  it('API-ключи: не видны, отзыв — 404', async () => {
    expect((await b.api.get('/api/api-keys')).body).toEqual([]);
    await expectSameAsMissing(() => b.api.delete(`/api/api-keys/${apiKeyId}`), () => b.api.delete(`/api/api-keys/${MISSING_ID}`), 404);
    const [k] = await sql<{ revoked_at: Date | null }>('SELECT revoked_at FROM api_keys WHERE id = $1', [apiKeyId]);
    expect(k!.revoked_at).toBeNull();
  });

  it('личные шаблоны: не видны ни в «моих», ни в каталоге; удаление и запуск — 404', async () => {
    expect((await b.api.get('/api/templates/mine')).body).toEqual([]);
    expect(JSON.stringify((await b.api.get('/api/catalog/templates')).body)).not.toContain('a-tpl');
    await expectSameAsMissing(() => b.api.delete(`/api/templates/${templateId}`), () => b.api.delete(`/api/templates/${MISSING_ID}`), 404);
    const launchWith = (id: number) => b.api.post('/api/instances', { name: 'x', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: id });
    await expectSameAsMissing(() => launchWith(templateId), () => launchWith(MISSING_ID), 404);
    expect(await sql('SELECT 1 FROM templates WHERE id = $1', [templateId])).toHaveLength(1);
  });
});

describe('чужие деньги', () => {
  it('чужой платёж оплатить нельзя, ответ как у несуществующего', async () => {
    await expectSameAsMissing(() => b.api.post(`/api/payments/${paymentId}/demo-pay`), () => b.api.post(`/api/payments/${MISSING_ID}/demo-pay`), 404);
    const [p] = await sql<{ status: string }>('SELECT status FROM payments WHERE id = $1', [paymentId]);
    expect(p!.status).toBe('pending');
    expect(await balanceOf(a.id)).toBe('5000.0000');
  });

  it('платёж на чужой счёт создать нельзя: userId в теле отклоняется, платёж всегда на вошедшего', async () => {
    const before = await sql<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [a.id]);
    for (const field of ['userId', 'user_id', 'accountId']) {
      expect((await b.api.post('/api/payments', { amount: 100, [field]: a.id })).status).toBe(400);
    }
    const mine = await b.api.post('/api/payments', { amount: 100 });
    expect((await sql<{ user_id: number }>('SELECT user_id FROM payments WHERE id = $1', [mine.body.payment.id]))[0]!.user_id).toBe(b.id);
    const after = await sql<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', [a.id]);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('история и расходы: чужие операции не видны, параметры userId игнорируются', async () => {
    await topUp(a.api, 123); // у A появилась операция
    for (const q of ['', `userId=${a.id}`, `user_id=${a.id}`]) {
      const tx = await b.api.get(`/api/billing/transactions?limit=100&${q}`);
      expect(tx.status).toBe(200);
      expect(tx.body.items.every((t: { description: string }) => !/123/.test(t.description))).toBe(true);
      const bTx = await sql<{ n: number }>('SELECT count(*)::int AS n FROM transactions WHERE user_id = $1', [b.id]);
      expect(tx.body.items).toHaveLength(bTx[0]!.n);
    }
    const spend = await b.api.get(`/api/billing/spend?userId=${a.id}`);
    expect(spend.body.byInstance).toEqual([]);
  });

  it('баланс — свой; /auth/me не принимает id', async () => {
    const me = await b.api.get(`/api/auth/me?id=${a.id}&userId=${a.id}`);
    expect(me.body.user.id).toBe(b.id);
    const balance = await b.api.get(`/api/billing/balance?userId=${a.id}`);
    expect(balance.body.balance).toBe(await balanceOf(b.id));
  });
});

describe('перебор идентификаторов и подмена заголовков', () => {
  it('подряд идущие числовые id вокруг чужого ресурса не открывают ничего чужого', async () => {
    for (let id = volumeId - 3; id <= volumeId + 3; id++) {
      const own = await sql('SELECT 1 FROM volumes WHERE id = $1 AND user_id = $2', [id, b.id]);
      const res = await b.api.post(`/api/volumes/${id}/extend`, { sizeGb: 20 });
      expect(res.status, `том ${id}`).toBe(own.length ? 200 : 404);
    }
  });

  it('заголовки X-User-Id, X-User-Role, X-Forwarded-User и cookie role=admin ни на что не влияют', async () => {
    const spoof = { 'X-User-Id': String(a.id), 'X-User-Role': 'admin', 'X-Forwarded-User': a.email };
    const me = await b.api.get('/api/auth/me', { headers: spoof });
    expect(me.body.user).toMatchObject({ id: b.id, role: 'client' });
    expect((await b.api.get('/api/admin/users', { headers: spoof })).status).toBe(403);
    const anon = await new Api(app).get('/api/admin/users', { headers: { ...spoof, Cookie: `role=admin; userId=${a.id}` } });
    expect(anon.status).toBe(401);
  });

  it('API-ключ определяет владельца целиком: по ключу A видны инстансы A', async () => {
    const created = await a.api.post('/api/api-keys', { name: 'another' });
    const viaKey = new Api(app);
    viaKey.bearer = created.body.key;
    const list = await viaKey.get('/api/instances');
    expect(list.body.map((i: { id: string }) => i.id)).toContain(inst);
  });
});

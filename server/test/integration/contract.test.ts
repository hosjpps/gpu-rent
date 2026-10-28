import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSshKey } from '../support/ssh';
import { ADMIN, Api, closeAll, launch, loginAs, makeApp, newUser, pickOffer } from './helpers';


// Фронтенд (web/src/api/types.ts) — потребитель API. Тест читает его описание типов и проверяет, что в настоящих ответах
// сервера есть все обязательные поля нужных типов: если бэкенд изменит форму ответа, расхождение найдётся здесь, а не в браузере.
const source = readFileSync(resolve(__dirname, '../../../web/src/api/types.ts'), 'utf8');

interface Field { name: string; optional: boolean; type: string }

function fieldsOf(name: string): Field[] {
  const m = new RegExp(`export interface ${name}(?:<[^>]*>)? \\{\\n([\\s\\S]*?)\\n\\}`).exec(source);
  if (!m) throw new Error(`в types.ts нет интерфейса ${name}`);
  const fields: Field[] = [];
  for (const line of m[1]!.split('\n')) {
    const f = /^ {2}(\w+)(\?)?: (.+);$/.exec(line); // только поля верхнего уровня (отступ два пробела)
    if (f) fields.push({ name: f[1]!, optional: Boolean(f[2]), type: f[3]! });
  }
  return fields;
}

const ALIASES: Record<string, string> = { Role: 'string', UserStatus: 'string', InstanceStatus: 'string', PricingType: 'string', TxType: 'string', PaymentStatus: 'string', NodeStatus: 'string' };

function typeMatches(value: unknown, declared: string): boolean {
  const parts = declared.split('|').map((p) => p.trim());
  return parts.some((p) => {
    const t = ALIASES[p] ?? p;
    if (t === 'null') return value === null;
    if (t === 'string' || /^'.*'$/.test(t)) return typeof value === 'string';
    if (t === 'number') return typeof value === 'number';
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'unknown' || t.startsWith('Record<')) return true;
    if (t.endsWith('[]')) return Array.isArray(value);
    if (t.startsWith('{')) return typeof value === 'object' && value !== null;
    return typeof value === 'object' && value !== null; // другой интерфейс: форму проверяем отдельно
  });
}

/** Все обязательные поля интерфейса есть в объекте, типы значений совпадают с объявленными. */
function expectShape(value: unknown, iface: string): void {
  expect(value, iface).toBeTypeOf('object');
  const obj = value as Record<string, unknown>;
  for (const f of fieldsOf(iface)) {
    if (f.optional && !(f.name in obj)) continue;
    expect(f.name in obj, `${iface}.${f.name} отсутствует`).toBe(true);
    expect(typeMatches(obj[f.name], f.type), `${iface}.${f.name}: ${JSON.stringify(obj[f.name])} не подходит под «${f.type}»`).toBe(true);
  }
}

const app = makeApp();
let user: Api;
let admin: Api;
let instanceId: string;
let paymentId: number;

beforeAll(async () => {
  const offer = await pickOffer(app, 8);
  const u = await newUser(app, { balance: 3000 });
  user = u.api;
  admin = await loginAs(app, ADMIN.email, ADMIN.password);
  await user.post('/api/volumes', { name: 'vol', datacenterCode: offer.dc, sizeGb: 20 });
  await user.post('/api/ssh-keys', { name: 'key', publicKey: makeSshKey().publicKey });
  await user.post('/api/templates', { name: 'tpl', dockerImage: 'registry.example.com/x/y:1', defaultDiskGb: 20 });
  instanceId = (await launch(u, offer, { name: 'contract' })).id;
  paymentId = (await user.post('/api/payments', { amount: 100 })).body.payment.id;
});
afterAll(closeAll);

describe('ответы сервера соответствуют web/src/api/types.ts', () => {
  it('пользователь: /auth/me, вход, регистрация', async () => {
    expectShape((await user.get('/api/auth/me')).body.user, 'User');
    const fresh = await new Api(app).post('/api/auth/register', { email: `c-${Date.now()}@example.test`, password: 'longenough1', fullName: 'Иван Петров' });
    expectShape(fresh.body.user, 'User');
    expectShape(fresh.body, 'VerifyInfo'); // в демо-режиме приходит verifyUrl
    expect(typeof fresh.body.verifyUrl).toBe('string');
  });

  it('каталог: GpuOffer и Template', async () => {
    const gpus = (await user.get('/api/catalog/gpus')).body;
    gpus.forEach((g: unknown) => expectShape(g, 'GpuOffer'));
    (await user.get('/api/catalog/templates')).body.forEach((t: unknown) => expectShape(t, 'Template'));
    (await user.get('/api/templates/mine')).body.forEach((t: unknown) => expectShape(t, 'Template'));
  });

  it('инстансы и тома', async () => {
    const list = (await user.get('/api/instances')).body;
    expect(list.length).toBeGreaterThan(0);
    list.forEach((i: unknown) => expectShape(i, 'Instance'));
    expectShape((await user.get(`/api/instances/${instanceId}`)).body, 'Instance');
    expectShape((await user.post(`/api/instances/${instanceId}/stop`)).body, 'Instance');
    (await user.get('/api/volumes')).body.forEach((v: unknown) => expectShape(v, 'Volume'));
  });

  it('ключи', async () => {
    (await user.get('/api/ssh-keys')).body.forEach((k: unknown) => expectShape(k, 'SshKey'));
    const created = await user.post('/api/api-keys', { name: 'contract' });
    expectShape(created.body, 'CreatedApiKey');
    expectShape(created.body.apiKey, 'ApiKey');
    (await user.get('/api/api-keys')).body.forEach((k: unknown) => expectShape(k, 'ApiKey'));
  });

  it('деньги: баланс, история, расходы, платежи', async () => {
    expectShape((await user.get('/api/billing/balance')).body, 'Balance');
    const page = (await user.get('/api/billing/transactions')).body;
    expectShape(page, 'Page');
    expect(page.items.length).toBeGreaterThan(0);
    page.items.forEach((t: unknown) => expectShape(t, 'Transaction'));
    const spend = (await user.get('/api/billing/spend')).body;
    expectShape(spend, 'Spend');
    const created = await user.post('/api/payments', { amount: 150 });
    expectShape(created.body, 'PaymentCreated');
    expectShape(created.body.payment, 'Payment');
    const paid = await user.post(`/api/payments/${paymentId}/demo-pay`);
    expectShape(paid.body.payment, 'Payment');
  });

  it('администратор: панель, цены, инфраструктура, пользователи, журнал', async () => {
    expectShape((await admin.get('/api/admin/dashboard')).body, 'Dashboard');
    const prices = (await admin.get('/api/admin/prices')).body;
    expect(prices.length).toBeGreaterThan(0);
    prices.forEach((p: unknown) => expectShape(p, 'AdminPrice'));
    const infra = (await admin.get('/api/admin/infrastructure')).body;
    infra.forEach((dc: Record<string, any>) => {
      expectShape(dc, 'InfraDatacenter');
      dc.nodes.forEach((n: Record<string, any>) => {
        expectShape(n, 'InfraNode');
        n.gpus.forEach((g: unknown) => expectShape(g, 'InfraGpu'));
      });
    });
    const users = (await admin.get('/api/admin/users')).body;
    expect(Array.isArray(users)).toBe(true);
    users.forEach((u: unknown) => expectShape(u, 'AdminUser'));
    const audit = (await admin.get('/api/admin/audit?limit=20')).body;
    expectShape(audit, 'Page');
    audit.items.forEach((e: unknown) => expectShape(e, 'AuditEntry'));
  });

  it('ошибка: {error: {code, message}} с текстом по-русски во всех классах отказов', async () => {
    const samples = [
      await user.get('/api/instances/not-a-uuid'),
      await user.get('/api/instances/00000000-0000-4000-8000-000000000000'),
      await user.post('/api/payments', { amount: 1 }),
      await user.get('/api/admin/users'),
      await user.get('/api/no/such/route'),
    ];
    for (const res of samples) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.body.error.code).toMatch(/^[A-Z_]+$/);
      expect(res.body.error.message).toMatch(/[А-Яа-я]/);
    }
  });
});

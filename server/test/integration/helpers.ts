import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';
import { afterAll, beforeAll, expect } from 'vitest';
import { createApp } from '../../src/app';
import { closePool } from '../../src/db';
import { signPayload } from '../../src/webhook';

export const ORIGIN = 'http://localhost:3000';
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const CRON_SECRET = 'test-cron-secret-0123456789ab';
export const ENC_KEY = 'test-enc-key-0123456789abcdef';
export const USER_PASSWORD = 'test-password-123';
export const DEMO = { email: 'demo@gpu-rent.example', password: process.env.TEST_DEMO_PASSWORD ?? 'demo-test-12345' };
export const ADMIN = { email: 'admin@gpu-rent.example', password: process.env.TEST_ADMIN_PASSWORD ?? 'admin-test-12345' };

/**
 * Окружение приложения в тестах. VERCEL=1 включает доверие к одному прокси: клиентский адрес берётся из X-Forwarded-For,
 * поэтому у каждого тестового клиента свой «IP» и счётчики попыток входа (они считаются по IP в БД) не мешают друг другу.
 */
export function testEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ENC_KEY,
    WEBHOOK_SECRET,
    CRON_SECRET,
    DEMO_MAIL: '1',
    DEMO_PAYMENTS: '1',
    APP_URL: ORIGIN,
    BCRYPT_COST: '4',
    LOG_LEVEL: 'silent',
    VERCEL: '1',
    AUTH_LOGIN_IP_MAX: '100000',
    AUTH_REGISTER_IP_MAX: '100000',
    ...over,
  };
}

// Запросы идут на один общий сервер, привязанный к 127.0.0.1 (а не supertest со своим сервером на каждый запрос).
// Причина: supertest слушает порт на всех адресах, а ходит на 127.0.0.1; если другая программа на машине занимает тот же
// порт именно на 127.0.0.1 (например, редактор кода), запрос уходит к ней и тест молча зависает. Сервер на 127.0.0.1:0
// получает порт, свободный для этого адреса. Нужное приложение выбирается заголовком X-Test-App.
const apps: Express[] = [];
const server = http.createServer((req, res) => {
  const app = apps[Number(req.headers['x-test-app'])];
  if (!app) {
    res.statusCode = 500;
    res.end('приложение не зарегистрировано в makeApp()');
    return;
  }
  delete req.headers['x-test-app'];
  (app as unknown as http.RequestListener)(req, res);
});
let baseUrl = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

export function makeApp(over: Record<string, string | undefined> = {}): Express {
  const app = createApp(testEnv(over));
  apps.push(app);
  return app;
}

/** Запрос к приложению без cookie-банки и заголовков: request(app) из supertest, но через общий сервер. */
export function bare(app: Express): Record<'get' | 'post' | 'put' | 'delete' | 'patch', (url: string) => Test> {
  const id = String(apps.indexOf(app));
  if (id === '-1') throw new Error('приложение создано не через makeApp()');
  const call = (method: 'get' | 'post' | 'put' | 'delete' | 'patch') => (url: string): Test => request(baseUrl)[method](url).set('X-Test-App', id).timeout({ deadline: 20_000 });
  return { get: call('get'), post: call('post'), put: call('put'), delete: call('delete'), patch: call('patch') };
}

const octet = () => 1 + Math.floor(Math.random() * 254);
export const randomIp = (): string => `10.${octet()}.${octet()}.${octet()}`;
export const uniq = (): string => randomBytes(5).toString('hex');
export const uniqEmail = (prefix = 'u'): string => `${prefix}-${uniq()}@example.test`;

interface Opts {
  /** false — не добавлять X-Requested-With и Origin (как запрос не из нашего фронтенда) */
  csrf?: boolean;
  /** null — не отправлять Origin совсем */
  origin?: string | null;
  headers?: Record<string, string>;
}

/**
 * HTTP-клиент поверх supertest: своя cookie-банка, «свой IP», заголовки CSRF на небезопасных методах.
 * Общий agent supertest закрывает сервер после первого ответа, и параллельные запросы получали бы ECONNRESET,
 * поэтому cookie ведём сами.
 */
export class Api {
  bearer: string | undefined;
  private readonly jar = new Map<string, string>();

  constructor(
    readonly app: Express,
    readonly ip: string = randomIp(),
  ) {}

  private capture(setCookie: string[] | undefined): void {
    for (const raw of setCookie ?? []) {
      const [pair, ...attrs] = raw.split(';').map((x) => x.trim());
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const expires = attrs.find((x) => /^expires=/i.test(x))?.slice('expires='.length);
      if (value === '' || (expires !== undefined && Date.parse(expires) <= Date.now())) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private prep(t: Test, unsafe: boolean, o: Opts): Test {
    if (this.jar.size) t.set('Cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    t.on('response', (res) => this.capture(res.headers['set-cookie'] as unknown as string[] | undefined));
    t.set('X-Forwarded-For', this.ip);
    if (this.bearer) t.set('Authorization', `Bearer ${this.bearer}`);
    if (unsafe && o.csrf !== false) {
      t.set('X-Requested-With', 'fetch');
      if (o.origin !== null) t.set('Origin', o.origin ?? ORIGIN);
    }
    for (const [k, v] of Object.entries(o.headers ?? {})) t.set(k, v);
    return t;
  }

  get(url: string, o: Opts = {}): Test {
    return this.prep(bare(this.app).get(url), false, o);
  }

  post(url: string, body?: unknown, o: Opts = {}): Test {
    const t = this.prep(bare(this.app).post(url), true, o);
    return body === undefined ? t : t.send(body as object);
  }

  delete(url: string, o: Opts = {}): Test {
    return this.prep(bare(this.app).delete(url), true, o);
  }
}

// ---------------------------------------------------------------- прямой доступ к БД

let ownerPool: pg.Pool | undefined;

/** Суперпользователь кластера: готовит данные и проверяет состояние в обход RLS. Приложение так не подключается никогда. */
export function owner(): pg.Pool {
  if (!ownerPool) {
    ownerPool = new pg.Pool({ connectionString: process.env.TEST_OWNER_URL, max: 3 });
    ownerPool.on('connect', (c) => void c.query('SET search_path = gpu_rent, public'));
    ownerPool.on('error', () => undefined);
  }
  return ownerPool;
}

export async function sql<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
  return (await owner().query<R>(text, params)).rows;
}

/** LOGIN-роль gpu_rent_web — та же, под которой работает приложение. Для негативных проверок прав. */
export function webPool(): pg.Pool {
  const p = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  p.on('error', () => undefined);
  return p;
}

const cleanup: (() => Promise<void>)[] = [];
export const onCleanup = (fn: () => Promise<void>): number => cleanup.push(fn);

/** Вызывается в afterAll каждого файла: освобождает GPU и закрывает соединения. */
export async function closeAll(): Promise<void> {
  for (const fn of cleanup.splice(0)) {
    try {
      await fn();
    } catch {
      // уборка не должна скрывать настоящий провал теста
    }
  }
  await closePool();
  await ownerPool?.end();
  ownerPool = undefined;
}

// ---------------------------------------------------------------- пользователи

export interface TestUser {
  api: Api;
  id: number;
  email: string;
  password: string;
}

export function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error(`в ссылке нет токена: ${link}`);
  return token;
}

export async function loginAs(app: Express, email: string, password: string, ip?: string): Promise<Api> {
  const api = new Api(app, ip);
  const res = await api.post('/api/auth/login', { email, password });
  expect(res.status, `вход ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return api;
}

/** Пополнение через API: платёж + демо-оплата (как делает интерфейс). */
export async function topUp(api: Api, amount: number | string): Promise<void> {
  const created = await api.post('/api/payments', { amount });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const paid = await api.post(`/api/payments/${created.body.payment.id}/demo-pay`);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  expect(paid.body.credited).toBe(true);
}

/**
 * Новый пользователь через настоящую регистрацию. По умолчанию email подтверждён (по демо-ссылке) и пользователь вошёл.
 * Баланс пополняется платёжным потоком, а не правкой БД.
 */
export async function newUser(
  app: Express,
  o: { verify?: boolean; balance?: number; login?: boolean; email?: string; password?: string; fullName?: string } = {},
): Promise<TestUser> {
  const email = o.email ?? uniqEmail();
  const password = o.password ?? USER_PASSWORD;
  const api = new Api(app);
  const reg = await api.post('/api/auth/register', { email, password, fullName: o.fullName ?? 'Тестовый Пользователь' });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const id = reg.body.user.id as number;
  if (o.verify !== false) {
    const v = await api.post('/api/auth/verify', { token: tokenFromLink(reg.body.verifyUrl) });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
  }
  if (o.login !== false) {
    const l = await api.post('/api/auth/login', { email, password });
    expect(l.status, JSON.stringify(l.body)).toBe(200);
  }
  const user: TestUser = { api, id, email, password };
  if (o.balance) {
    let left = o.balance;
    while (left > 0) {
      const part = Math.min(left, 100_000);
      await topUp(api, part);
      left -= part;
    }
  }
  onCleanup(() => terminateAllInstances(user));
  return user;
}

/** Завершает все живые инстансы пользователя, чтобы GPU освободились для следующих тестов. */
export async function terminateAllInstances(user: TestUser): Promise<void> {
  const list = await user.api.get('/api/instances');
  if (list.status !== 200) return;
  for (const i of list.body as { id: string; status: string }[]) {
    if (i.status === 'running' || i.status === 'stopped' || i.status === 'pending') await user.api.post(`/api/instances/${i.id}/terminate`);
  }
}

export async function balanceOf(userId: number): Promise<string> {
  return (await sql<{ balance: string }>('SELECT balance FROM users WHERE id = $1', [userId]))[0]!.balance;
}

// ---------------------------------------------------------------- каталог и запуск инстансов

export interface Offer {
  dc: string;
  model: string;
  free: number;
  total: number;
  priceOnDemand: string;
  priceSpot: string;
}

/** Предложение с запасом свободных GPU, самое дешёвое. Выбирается по текущему каталогу, а не зашито в тест. */
export async function pickOffer(app: Express, minFree = 4, maxFree = Number.POSITIVE_INFINITY): Promise<Offer> {
  const res = await bare(app).get('/api/catalog/gpus');
  expect(res.status).toBe(200);
  const rows = (res.body as { datacenter: { code: string }; model: { name: string }; free: number; total: number; priceOnDemand: string | null; priceSpot: string | null }[])
    .filter((r) => r.free >= minFree && r.free <= maxFree && r.priceOnDemand !== null && r.priceSpot !== null)
    .sort((a, b) => Number(a.priceOnDemand) - Number(b.priceOnDemand));
  const r = rows[0];
  if (!r) throw new Error(`в каталоге нет предложения со свободными GPU от ${minFree} до ${maxFree}`);
  return { dc: r.datacenter.code, model: r.model.name, free: r.free, total: r.total, priceOnDemand: r.priceOnDemand!, priceSpot: r.priceSpot! };
}

export function launchBody(offer: Offer, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `inst-${uniq()}`,
    datacenterCode: offer.dc,
    gpuModel: offer.model,
    gpuCount: 1,
    pricingType: 'on_demand',
    templateId: 1,
    containerDiskGb: 50,
    ...over,
  };
}

export async function launch(user: TestUser, offer: Offer, over: Record<string, unknown> = {}): Promise<{ id: string; body: Record<string, any> }> {
  const res = await user.api.post('/api/instances', launchBody(offer, over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.id as string, body: res.body };
}

// ---------------------------------------------------------------- вебхук

export function webhookBody(paymentProviderId: string, amount: string, status: 'succeeded' | 'failed' = 'succeeded'): string {
  return JSON.stringify({ paymentId: paymentProviderId, status, amount });
}

/** Уведомление платёжного шлюза: подпись HMAC считается от сырого тела. */
export function sendWebhook(app: Express, raw: string, signature: string | null = signPayload(WEBHOOK_SECRET, raw)): Test {
  const t = bare(app).post('/api/webhooks/payments').set('Content-Type', 'application/json').set('X-Forwarded-For', randomIp());
  if (signature !== null) t.set('X-Signature', signature);
  return t.send(raw);
}

export async function providerIdOf(paymentId: number): Promise<string> {
  return (await sql<{ provider_payment_id: string }>('SELECT provider_payment_id FROM payments WHERE id = $1', [paymentId]))[0]!.provider_payment_id;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

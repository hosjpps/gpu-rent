import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CRON_SECRET, ENC_KEY, ORIGIN, WEBHOOK_SECRET, closeAll, sleep, sql, uniq } from './helpers';

// Настоящий процесс: так сервер запускается локально (npm run dev:server) и так работал бы на любой машине с Node.
const serverDir = resolve(__dirname, '../..');
let child: ChildProcess | undefined;
const output: string[] = [];

afterAll(async () => {
  child?.kill('SIGKILL');
  await closeAll();
});

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = net.createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => ok(port));
    });
  });

describe('локальный запуск src/index.ts', () => {
  const password = `Pr0cess-${uniq()}-secret`;
  const email = `proc-${uniq()}@example.test`;
  let base = '';
  let exit: Promise<number | null>;

  it('поднимается на PORT и отвечает', async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(resolve(serverDir, 'node_modules/.bin/tsx'), ['src/index.ts'], {
      cwd: serverDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'development',
        PORT: String(port),
        LOG_LEVEL: 'info',
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        ENC_KEY,
        WEBHOOK_SECRET,
        CRON_SECRET,
        DEMO_MAIL: '1',
        APP_URL: ORIGIN,
        BCRYPT_COST: '4',
      },
    });
    exit = new Promise((r) => child!.once('exit', (code) => r(code)));
    child.stdout!.on('data', (d: Buffer) => output.push(...d.toString().split('\n').filter(Boolean)));
    child.stderr!.on('data', (d: Buffer) => output.push(...d.toString().split('\n').filter(Boolean)));

    for (let i = 0; i < 100 && !output.some((l) => l.includes('GPU Rent API: http://localhost:')); i++) await sleep(100);
    expect(output.some((l) => l.includes(`GPU Rent API: http://localhost:${port}`))).toBe(true);
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  }, 20_000);

  it('работает с настоящим клиентом: регистрация, подтверждение, вход, ключ API', async () => {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Origin: ORIGIN };
    const call = async (path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) => {
      const h: Record<string, string> = { ...headers };
      if (init.cookie) h.Cookie = init.cookie;
      if (init.bearer) h.Authorization = `Bearer ${init.bearer}`;
      return fetch(`${base}${path}`, { ...init, headers: h });
    };
    const reg = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, fullName: 'Иван Процессов' }) });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as { verifyUrl: string };
    const token = new URL(regBody.verifyUrl).searchParams.get('token')!;
    expect((await call('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) })).status).toBe(200);

    const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).toMatch(/^sid=/);
    const requestId = login.headers.get('x-request-id')!;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

    const me = await call('/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    const created = (await (await call('/api/api-keys', { method: 'POST', cookie, body: JSON.stringify({ name: 'proc' }) })).json()) as { key: string };
    const key = created.key;
    expect((await call('/api/auth/me', { bearer: key })).status).toBe(200);
    expect((await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'wrong-password-x' }) })).status).toBe(401);
    await sleep(300);

    // каждый запрос — одна JSON-строка с request-id, методом, путём, статусом и временем
    const logs = output.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, any>);
    const requests = logs.filter((l) => l.msg === 'request');
    expect(requests.length).toBeGreaterThanOrEqual(8);
    for (const r of requests) {
      expect(r).toMatchObject({ level: 30, reqId: expect.any(String), method: expect.any(String), path: expect.any(String), status: expect.any(Number), ms: expect.any(Number) });
      expect(Number.isNaN(Date.parse(r.time))).toBe(false);
    }
    expect(requests.find((r) => r.reqId === requestId)).toMatchObject({ method: 'POST', status: 200, path: '/api/auth/login' });
    expect(requests.some((r) => r.path === '/api/api-keys')).toBe(true); // путь полный, с префиксом вложенного роутера
    expect(requests.some((r) => r.status === 401 && r.userId === undefined)).toBe(true);
    expect(requests.some((r) => r.userId !== undefined)).toBe(true); // после входа запросы привязаны к пользователю

    // секретов в логе нет: ни пароля, ни токена cookie, ни ключа API, ни токена подтверждения
    const text = output.join('\n');
    for (const secret of [password, cookie.slice('sid='.length), key, token, 'wrong-password-x']) expect(text, secret.slice(0, 6)).not.toContain(secret);
    const hashes = await sql<{ password_hash: string }>('SELECT password_hash FROM users WHERE email = $1', [email]);
    expect(text).not.toContain(hashes[0]!.password_hash);
  }, 30_000);

  it('по SIGTERM корректно завершается (код 0) и закрывает пул', async () => {
    child!.kill('SIGTERM');
    const code = await Promise.race([exit, sleep(10_000).then(() => 'не завершился за 10 с')]);
    expect(code).toBe(0);
    // подключений роли gpu_rent_web от этого процесса не осталось
    await sleep(200);
    const left = await sql<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'gpu_rent_web' AND datname = current_database()");
    expect(left[0]!.n).toBe(0); // у самого тестового процесса в этом файле пула приложения нет
  }, 20_000);
});

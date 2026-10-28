import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, withUser } from '../../src/db';
import { closeAll, launch, makeApp, newUser, owner, pickOffer, sql } from './helpers';
import type { Offer, TestUser } from './helpers';

const app = makeApp(); // создание приложения настраивает пул (DATABASE_URL тестовой БД, max = 2)
let a: TestUser;
let b: TestUser;
let offer: Offer;

beforeAll(async () => {
  offer = await pickOffer(app, 8);
  a = await newUser(app, { balance: 3000 });
  b = await newUser(app, { balance: 3000 });
});
afterAll(closeAll);

const readContext = () =>
  getPool().query<{ u: string | null; r: string | null; ip: string | null; k: string | null }>(
    "SELECT current_setting('app.user_id', true) AS u, current_setting('app.user_role', true) AS r, current_setting('app.client_ip', true) AS ip, current_setting('app.enc_key', true) AS k",
  );
const isEmpty = (v: string | null | undefined): boolean => v === null || v === undefined || v === '';

describe('withUser: контекст одной транзакции', () => {
  it('одно соединение на всю транзакцию: контекст виден во всех запросах внутри', async () => {
    const out = await withUser({ userId: a.id, role: 'client', ip: '203.0.113.7' }, async (c) => {
      const pid1 = (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
      const ctx = (await c.query<{ u: string; r: string; ip: string }>("SELECT current_setting('app.user_id') AS u, current_setting('app.user_role') AS r, current_setting('app.client_ip') AS ip")).rows[0]!;
      const pid2 = (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
      return { pid1, pid2, ctx };
    });
    expect(out.pid1).toBe(out.pid2);
    expect(out.ctx).toEqual({ u: String(a.id), r: 'client', ip: '203.0.113.7' });
  });

  it('некорректный IP не записывается; анонимный контекст не имеет ни пользователя, ни роли', async () => {
    const bad = await withUser({ userId: a.id, role: 'client', ip: "1.2.3.4'; DROP TABLE users;--" }, async (c) => (await c.query<{ ip: string }>("SELECT current_setting('app.client_ip') AS ip")).rows[0]!.ip);
    expect(bad).toBe('');
    const v6 = await withUser({ userId: a.id, role: 'client', ip: '2001:db8::1' }, async (c) => (await c.query<{ ip: string }>("SELECT current_setting('app.client_ip') AS ip")).rows[0]!.ip);
    expect(v6).toBe('2001:db8::1');
    const anon = await withUser({ role: 'anon' }, async (c) => (await c.query<{ u: string; r: string }>("SELECT current_setting('app.user_id') AS u, current_setting('app.user_role') AS r")).rows[0]!);
    expect(anon).toEqual({ u: '', r: '' });
  });

  it('после COMMIT контекст не остаётся на соединении, вернувшемся в пул', async () => {
    for (let i = 0; i < 6; i++) await withUser({ userId: a.id, role: 'admin', ip: '203.0.113.9' }, (c) => c.query('SELECT 1'));
    for (let i = 0; i < 6; i++) {
      const ctx = (await readContext()).rows[0]!;
      expect(isEmpty(ctx.u) && isEmpty(ctx.r) && isEmpty(ctx.ip) && isEmpty(ctx.k)).toBe(true);
    }
  });

  it('исключение посреди транзакции: ROLLBACK, контекст не утекает в следующие запросы, соединение возвращается в пул', async () => {
    const pids = new Set<number>();
    for (let i = 0; i < 8; i++) {
      await expect(
        withUser({ userId: b.id, role: 'admin', ip: '203.0.113.10' }, async (c) => {
          pids.add((await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p);
          await c.query("SELECT fn_auth_throttle_hit('t_midway', $1, 5, 60)", [`k${i}`]);
          throw new Error('сбой посреди транзакции');
        }),
      ).rejects.toThrow('сбой посреди транзакции');
    }
    expect(pids.size).toBeLessThanOrEqual(2); // пул из двух соединений использовался повторно

    for (let i = 0; i < 8; i++) {
      const ctx = (await readContext()).rows[0]!;
      expect(isEmpty(ctx.u) && isEmpty(ctx.r) && isEmpty(ctx.ip) && isEmpty(ctx.k), JSON.stringify(ctx)).toBe(true);
    }
    // запись внутри откатилась
    expect(await sql("SELECT 1 FROM auth_attempts WHERE scope = 't_midway'")).toHaveLength(0);
    const pool = getPool();
    expect(pool.totalCount).toBeLessThanOrEqual(2);
    expect(pool.idleCount).toBe(pool.totalCount);
    expect(pool.waitingCount).toBe(0);
  });

  it('ошибка SQL внутри транзакции (она становится «прерванной») не портит соединение для следующего запроса', async () => {
    for (let i = 0; i < 4; i++) {
      await expect(withUser({ userId: a.id, role: 'client' }, (c) => c.query('SELECT * FROM table_that_does_not_exist'))).rejects.toMatchObject({ code: '42P01' });
    }
    const ok = await withUser({ userId: a.id, role: 'client' }, (c) => c.query('SELECT 1 AS one'));
    expect(ok.rows[0]!.one).toBe(1);
    expect(isEmpty((await readContext()).rows[0]!.u)).toBe(true);
  });

  it('успешная транзакция фиксируется целиком', async () => {
    await withUser({ userId: a.id, role: 'client' }, (c) => c.query("SELECT fn_auth_throttle_hit('t_commit', 'k', 5, 60)"));
    expect(await sql("SELECT 1 FROM auth_attempts WHERE scope = 't_commit'")).toHaveLength(1);
  });

  it('много неудачных вызовов подряд не исчерпывают пул', async () => {
    for (let i = 0; i < 30; i++) await withUser({ role: 'anon' }, async () => Promise.reject(new Error('x'))).catch(() => undefined);
    const ok = await Promise.all([1, 2, 3, 4, 5].map((n) => withUser({ role: 'anon' }, async (c) => (await c.query<{ n: number }>('SELECT $1::int AS n', [n])).rows[0]!.n)));
    expect(ok).toEqual([1, 2, 3, 4, 5]);
    expect(getPool().waitingCount).toBe(0);
  });

  it('соединение, умершее посреди транзакции, не возвращается в пул и не роняет процесс', async () => {
    let victim = 0;
    await expect(
      withUser({ userId: a.id, role: 'client' }, async (c) => {
        victim = (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
        await owner().query('SELECT pg_terminate_backend($1)', [victim]);
        // ждём, пока сервер действительно закроет сессию, чтобы следующий запрос гарантированно упал
        for (let i = 0; i < 60; i++) {
          if ((await owner().query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [victim])).rowCount === 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await new Promise((r) => setTimeout(r, 100));
        await c.query('SELECT 1');
      }),
    ).rejects.toBeTruthy();
    // следующие вызовы работают на новых соединениях
    for (let i = 0; i < 3; i++) {
      const pid = await withUser({ userId: a.id, role: 'client' }, async (c) => (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p);
      expect(pid).not.toBe(victim);
    }
    expect(getPool().totalCount).toBeLessThanOrEqual(2);
  });
});

describe('withUser: параллельные запросы разных пользователей', () => {
  it('40 одновременных транзакций двух пользователей на пуле из двух соединений видят каждый свой контекст', async () => {
    const jobs = Array.from({ length: 40 }, (_, i) => {
      const who = i % 2 === 0 ? a : b;
      return withUser({ userId: who.id, role: 'client' }, async (c) => {
        await c.query('SELECT pg_sleep(0.01)');
        const ctx = (await c.query<{ u: string }>("SELECT current_setting('app.user_id') AS u")).rows[0]!.u;
        const seen = (await c.query<{ id: number }>('SELECT id FROM users')).rows.map((r) => r.id); // RLS по этому контексту
        return { want: who.id, ctx: Number(ctx), seen };
      });
    });
    const results = await Promise.all(jobs);
    for (const r of results) {
      expect(r.ctx).toBe(r.want);
      expect(r.seen).toEqual([r.want]);
    }
  });

  it('через API: параллельные GET /api/instances двух пользователей возвращают каждому только своё', async () => {
    const mine = await launch(a, offer, { name: 'only-a' });
    await launch(b, offer, { name: 'only-b-1' });
    await launch(b, offer, { name: 'only-b-2' });
    const calls = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? a : b).api.get('/api/instances').then((r) => ({ who: i % 2 === 0 ? 'a' : 'b', r })));
    for (const { who, r } of await Promise.all(calls)) {
      expect(r.status).toBe(200);
      const names = r.body.map((x: { name: string }) => x.name).sort();
      expect(names, who).toEqual(who === 'a' ? expect.arrayContaining(['only-a']) : expect.arrayContaining(['only-b-1', 'only-b-2']));
      expect(names.some((n: string) => (who === 'a' ? n.startsWith('only-b') : n === 'only-a'))).toBe(false);
    }
    expect(mine.id).toBeTruthy();
  });

  it('через API: 20 параллельных платежей от каждого из двух пользователей создаются каждому на своё имя', async () => {
    const jobs = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).api.post('/api/payments', { amount: 10 + (i % 2) }));
    const done = await Promise.all(jobs);
    expect(done.every((r) => r.status === 201)).toBe(true);
    const rows = await sql<{ user_id: number; amount: string; n: number }>(
      "SELECT user_id, amount, count(*)::int AS n FROM payments WHERE user_id IN ($1, $2) AND amount IN (10, 11) GROUP BY user_id, amount ORDER BY user_id",
      [a.id, b.id],
    );
    const byUser = Object.fromEntries(rows.map((r) => [`${r.user_id}:${Number(r.amount)}`, r.n]));
    expect(byUser[`${a.id}:10`]).toBe(20); // чётные номера — A, сумма 10
    expect(byUser[`${b.id}:11`]).toBe(20); // нечётные — B, сумма 11
    expect(byUser[`${a.id}:11`]).toBeUndefined();
    expect(byUser[`${b.id}:10`]).toBeUndefined();
  });

  it('одновременные запуски двух пользователей не смешивают владельцев инстансов', async () => {
    const jobs = [a, b, a, b].map((u, i) => u.api.post('/api/instances', { name: `race-${i}`, datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'spot', templateId: 1 }));
    const done = await Promise.all(jobs);
    expect(done.every((r) => r.status === 201)).toBe(true);
    const rows = await sql<{ name: string; user_id: number }>("SELECT name, user_id FROM instances WHERE name LIKE 'race-%' ORDER BY name");
    expect(rows).toEqual([
      { name: 'race-0', user_id: a.id },
      { name: 'race-1', user_id: b.id },
      { name: 'race-2', user_id: a.id },
      { name: 'race-3', user_id: b.id },
    ]);
  });
});

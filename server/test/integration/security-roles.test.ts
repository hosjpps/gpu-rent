import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../../src/db';
import { makeSshKey } from '../support/ssh';
import { ADMIN, Api, closeAll, launch, loginAs, makeApp, newUser, pickOffer, bare, sql, uniq, webPool } from './helpers';
import type { Offer, TestUser } from './helpers';

const app = makeApp();
const web: Pool = webPool(); // настоящая LOGIN-роль gpu_rent_web
let offer: Offer;
let a: TestUser;
let b: TestUser;
const res: Record<string, number> = {}; // id ресурсов пользователя B
let instanceId = ''; // его инстанс

afterAll(async () => {
  await web.end();
  await closeAll();
});

type Ctx = { userId?: number; role?: string };

/** Транзакция под gpu_rent_web с заданным контекстом приложения; в конце откат — тест ничего не меняет. */
async function inContext<T>(ctx: Ctx, fn: (c: PoolClient, code: (q: string, p?: unknown[]) => Promise<string | null>) => Promise<T>): Promise<T> {
  const c = await web.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.user_role', $2, true)", [ctx.userId === undefined ? '' : String(ctx.userId), ctx.role ?? '']);
    // код ошибки SQLSTATE запроса (или null, если запрос выполнился); транзакция при этом остаётся пригодной
    const code = async (q: string, p: unknown[] = []): Promise<string | null> => {
      await c.query('SAVEPOINT probe');
      try {
        await c.query(q, p);
        await c.query('RELEASE SAVEPOINT probe');
        return null;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT probe');
        return (e as { code?: string }).code ?? 'unknown';
      }
    };
    return await fn(c, code);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

beforeAll(async () => {
  offer = await pickOffer(app, 8);
  a = await newUser(app, { balance: 3000 });
  b = await newUser(app, { balance: 3000 });
  res.volume = (await b.api.post('/api/volumes', { name: 'b-vol', datacenterCode: offer.dc, sizeGb: 20 })).body.id;
  res.sshKey = (await b.api.post('/api/ssh-keys', { name: 'b-key', publicKey: makeSshKey().publicKey })).body.id;
  res.template = (await b.api.post('/api/templates', { name: 'b-tpl', dockerImage: 'registry.example.com/b/env:1', defaultDiskGb: 20 })).body.id;
  res.payment = (await b.api.post('/api/payments', { amount: 100 })).body.payment.id;
  res.apiKey = (await b.api.post('/api/api-keys', { name: 'b-api' })).body.apiKey.id;
  const run = await launch(b, offer, { env: { SECRET: 'b-secret-value' } });
  instanceId = run.id;
  await launch(a, offer);
});

describe('роль gpu_rent_web', () => {
  it('приложение подключается именно этой ролью, а она — не владелец, не суперпользователь и без обхода RLS', async () => {
    const who = await withUser({ role: 'anon' }, (c) => c.query<{ u: string }>('SELECT current_user AS u'));
    expect(who.rows[0]!.u).toBe('gpu_rent_web');

    const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolcanlogin: boolean; rolconnlimit: number }>(
      "SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = 'gpu_rent_web'",
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolcanlogin: true, rolconnlimit: 20 });
  });

  it('членство: gpu_rent_app — да; владелец схемы и аналитик — нет (pg_auth_members)', async () => {
    const members = await sql<{ role: string }>(
      "SELECT r.rolname AS role FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'gpu_rent_web' ORDER BY 1",
    );
    expect(members.map((m) => m.role)).toEqual(['gpu_rent_app']);
    const [priv] = await sql<{ owner: boolean; analyst: boolean }>(
      "SELECT pg_has_role('gpu_rent_web', 'gpu_rent_owner', 'member') AS owner, pg_has_role('gpu_rent_web', 'gpu_rent_analyst', 'member') AS analyst",
    );
    expect(priv).toEqual({ owner: false, analyst: false });
  });

  it('настройки роли: схема, потолок времени запроса и «зависшей» транзакции', async () => {
    const c = await web.connect();
    try {
      expect((await c.query('SHOW search_path')).rows[0].search_path).toBe('gpu_rent, pg_catalog');
      expect((await c.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('15s');
      expect((await c.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('30s');
    } finally {
      c.release();
    }
  });

  it('нельзя стать владельцем, создавать роли и объекты, менять схему', async () => {
    await inContext({}, async (_c, code) => {
      expect(await code('SET ROLE gpu_rent_owner')).toBe('42501');
      expect(await code('SET ROLE postgres')).not.toBeNull();
      expect(await code('CREATE ROLE evil SUPERUSER')).toBe('42501');
      expect(await code('CREATE TABLE gpu_rent.evil (id int)')).toBe('42501');
      expect(await code('DROP TABLE gpu_rent.users')).toBe('42501');
      expect(await code('ALTER TABLE gpu_rent.users DISABLE ROW LEVEL SECURITY')).toBe('42501');
      expect(await code('CREATE FUNCTION gpu_rent.evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$')).toBe('42501');
      expect(await code('GRANT gpu_rent_owner TO gpu_rent_web')).toBe('42501');
    });
  });
});

describe('таблицы, закрытые для приложения целиком', () => {
  it.each([
    'SELECT password_hash FROM users',
    'SELECT * FROM users',
    "UPDATE users SET role = 'admin'",
    "UPDATE users SET balance = 1000000, status = 'active'",
    "INSERT INTO users (email, password_hash, full_name) VALUES ('evil@example.test', 'x', 'Evil')",
    'DELETE FROM users',
    'SELECT * FROM sessions',
    'DELETE FROM sessions',
    'SELECT * FROM auth_attempts',
    'SELECT * FROM email_tokens',
    'SELECT * FROM billing_runs',
    "INSERT INTO transactions (user_id, type, amount, description) VALUES (1, 'topup', 1000000, 'free money')",
    'UPDATE transactions SET amount = 0',
    'DELETE FROM transactions',
    'TRUNCATE transactions',
    "UPDATE audit_log SET action = 'x'",
    'DELETE FROM audit_log',
    'INSERT INTO usage_records (user_id, kind, period_start, period_end, quantity, amount) VALUES (1, \'gpu\', now(), now(), 0, 0)',
    'DELETE FROM usage_records',
  ])('%s -> permission denied (42501), даже с контекстом администратора', async (statement) => {
    await inContext({ userId: 1, role: 'admin' }, async (_c, code) => {
      expect(await code(statement)).toBe('42501');
    });
    await inContext({}, async (_c, code) => {
      expect(await code(statement)).toBe('42501');
    });
  });
});

describe('RLS: контекст клиента', () => {
  it('таблицы с пользовательскими данными показывают только строки текущего пользователя', async () => {
    await inContext({ userId: a.id, role: 'client' }, async (c) => {
      expect((await c.query('SELECT id FROM users')).rows.map((r) => r.id)).toEqual([a.id]);
      for (const table of ['instances', 'volumes', 'ssh_keys', 'api_keys', 'payments', 'transactions']) {
        const rows = (await c.query(`SELECT DISTINCT user_id FROM ${table}`)).rows.map((r) => r.user_id);
        expect(rows.every((id: number) => id === a.id), table).toBe(true);
      }
      expect((await c.query('SELECT 1 FROM instances WHERE user_id = $1', [b.id])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM volumes WHERE id = $1', [res.volume])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM ssh_keys WHERE id = $1', [res.sshKey])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM api_keys WHERE id = $1', [res.apiKey])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM payments WHERE id = $1', [res.payment])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM instance_env_vars')).rowCount).toBe(0); // переменные окружения B не видны, у A их нет
    });
  });

  it('шаблоны: публичные видны всем, чужие приватные — нет', async () => {
    await inContext({ userId: a.id, role: 'client' }, async (c) => {
      const rows = (await c.query('SELECT id, is_public, owner_id FROM templates')).rows;
      expect(rows.filter((t) => t.is_public)).toHaveLength(8);
      expect(rows.find((t) => t.id === res.template)).toBeUndefined();
      expect(rows.every((t) => t.is_public || t.owner_id === a.id)).toBe(true);
    });
  });

  it('аноним (нет app.user_id) не видит ничего персонального', async () => {
    await inContext({}, async (c) => {
      for (const table of ['users', 'instances', 'volumes', 'ssh_keys', 'api_keys', 'payments', 'transactions', 'instance_env_vars']) {
        expect((await c.query(`SELECT 1 FROM ${table}`)).rowCount, table).toBe(0);
      }
      expect((await c.query('SELECT 1 FROM templates WHERE NOT is_public')).rowCount).toBe(0);
    });
  });

  it('администратор в контексте видит всех, но менять таблицу users всё равно не может', async () => {
    const [adm] = await sql<{ id: number }>("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    await inContext({ userId: adm!.id, role: 'admin' }, async (c, code) => {
      expect((await c.query('SELECT 1 FROM users')).rowCount).toBeGreaterThan(50);
      expect(await code(`UPDATE users SET role = 'admin' WHERE id = ${a.id}`)).toBe('42501');
      expect(await code(`UPDATE users SET status = 'blocked' WHERE id = ${a.id}`)).toBe('42501'); // только через fn_admin_set_user_status
    });
  });

  it('чужие строки не изменить и не удалить: UPDATE/DELETE затрагивают 0 строк', async () => {
    await inContext({ userId: a.id, role: 'client' }, async (c) => {
      expect((await c.query("UPDATE templates SET name = 'hacked' WHERE id = $1", [res.template])).rowCount).toBe(0);
      expect((await c.query('DELETE FROM templates WHERE id = $1', [res.template])).rowCount).toBe(0);
      expect((await c.query("UPDATE templates SET name = 'hacked' WHERE id = 1")).rowCount).toBe(0); // публичный шаблон каталога
      expect((await c.query('DELETE FROM templates WHERE id = 1')).rowCount).toBe(0);
      expect((await c.query('UPDATE volumes SET size_gb = 5000 WHERE id = $1', [res.volume])).rowCount).toBe(0);
      expect((await c.query('DELETE FROM ssh_keys WHERE id = $1', [res.sshKey])).rowCount).toBe(0);
      expect((await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [res.apiKey])).rowCount).toBe(0);
      expect((await c.query("UPDATE payments SET status = 'succeeded' WHERE id = $1", [res.payment])).rowCount).toBe(0);
    });
    const [tpl] = await sql<{ name: string }>('SELECT name FROM templates WHERE id = $1', [res.template]);
    expect(tpl!.name).toBe('b-tpl');
  });

  it('создать строку на чужое имя нельзя: RLS WITH CHECK -> 42501', async () => {
    await inContext({ userId: a.id, role: 'client' }, async (_c, code) => {
      expect(await code("INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES ($1, 'demo', 'x-' || gen_random_uuid(), 100)", [b.id])).toBe('42501');
      expect(await code("INSERT INTO volumes (user_id, datacenter_id, name, size_gb) VALUES ($1, 1, 'v', 10)", [b.id])).toBe('42501');
      expect(await code("INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES ($1, 'k', 'ssh-ed25519 AAAA', 'SHA256:x')", [b.id])).toBe('42501');
      expect(await code("INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'k', 'gr_xxxxx', decode(repeat('ab', 32), 'hex'))", [b.id])).toBe('42501');
      expect(await code("INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, default_ports, is_public) VALUES ($1, 't', 'img', 10, '', false)", [b.id])).toBe('42501');
      expect(await code("INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, default_ports, is_public) VALUES (NULL, 't', 'img', 10, '', true)")).toBe('42501'); // публичный шаблон
    });
  });

  it('свою строку создать можно (проверка, что запреты выше не от поломки)', async () => {
    await inContext({ userId: a.id, role: 'client' }, async (_c, code) => {
      expect(await code("INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES ($1, 'demo', 'x-' || gen_random_uuid(), 100)", [a.id])).toBeNull();
    });
  });
});

describe('функции БД: защита не зависит от проверок в роутах', () => {
  it('служебные функции доступны только системному контексту', async () => {
    for (const ctx of [{ userId: a.id, role: 'client' }, {}]) {
      await inContext(ctx, async (_c, code) => {
        expect(await code('SELECT fn_bill_usage()')).toBe('42501');
        expect(await code("SELECT fn_payment_confirm('demo', 'x', 'succeeded', 1)")).toBe('42501');
        expect(await code('SELECT fn_billing_run_done(\'{}\'::jsonb)')).toBe('42501');
        expect(await code('SELECT fn_web_cleanup()')).toBe('42501');
        expect(await code(`SELECT fn_topup(${res.payment})`)).toBe('42501');
        expect(await code('SELECT fn_refresh_daily_revenue()')).toBe('42501');
      });
    }
  });

  it('клиент не может блокировать пользователей и управлять чужими инстансами напрямую', async () => {
    await inContext({ userId: a.id, role: 'client' }, async (_c, code) => {
      expect(await code(`SELECT fn_admin_set_user_status(${b.id}, 'blocked')`)).toBe('42501');
      expect(await code('SELECT fn_stop_instance($1::uuid)', [instanceId])).toBe('42501');
      expect(await code('SELECT fn_terminate_instance($1::uuid)', [instanceId])).toBe('42501');
      expect(await code('SELECT fn_resume_instance($1::uuid)', [instanceId])).toBe('42501');
      expect(await code("SELECT fn_env_get($1::uuid, 'SECRET')", [instanceId])).toBe('42501');
      expect(await code("SELECT fn_env_set($1::uuid, 'X', 'y')", [instanceId])).toBe('42501');
      expect(await code(`SELECT fn_start_instance(${b.id}::bigint, 1::bigint, 1::bigint, 1, 'on_demand', 1::bigint, 'steal')`)).toBe('42501'); // запуск за счёт B
      expect(await code('SELECT fn_bill_current_user()')).toBeNull(); // своё — можно
    });
    expect((await sql<{ status: string }>('SELECT status FROM instances WHERE id = $1', [instanceId]))[0]!.status).toBe('running');
    expect((await sql<{ status: string }>('SELECT status FROM users WHERE id = $1', [b.id]))[0]!.status).toBe('active');
  });

  it('и без контекста пользователя функции, которым он нужен, отказывают', async () => {
    await inContext({}, async (_c, code) => {
      expect(await code('SELECT fn_bill_current_user()')).toBe('42501');
      expect(await code('SELECT fn_web_password_hash()')).toBe('42501');
      expect(await code("SELECT fn_web_set_password('x', decode(repeat('ab', 32), 'hex'), 100, NULL, NULL)")).toBe('42501');
      expect(await code("SELECT fn_web_email_token_create(decode(repeat('ab', 32), 'hex'), 100)")).toBe('42501');
    });
  });
});

describe('через API: «присвоить себе admin» и другие привилегированные поля', () => {
  const privileged = { role: 'admin', status: 'active', balance: '99999.0000', isAdmin: true, emailVerified: true, userId: 1, ownerId: 1, isPublic: true, password_hash: 'x', passwordHash: 'x' };
  const valid = (): [string, string, object][] => [
    ['post', '/api/auth/register', { email: `p-${uniq()}@example.test`, password: 'longenough1', fullName: 'Иван Петров' }],
    ['post', '/api/auth/login', { email: a.email, password: a.password }],
    ['post', '/api/auth/password', { currentPassword: a.password, newPassword: 'another-pass-1' }],
    ['post', '/api/auth/verify', { token: 'x'.repeat(43) }],
    ['post', '/api/payments', { amount: 100 }],
    ['post', '/api/ssh-keys', { name: 'k', publicKey: makeSshKey().publicKey }],
    ['post', '/api/api-keys', { name: 'k' }],
    ['post', '/api/templates', { name: 't', dockerImage: 'registry.example.com/x/y:1', defaultDiskGb: 20 }],
    ['post', '/api/volumes', { name: 'v', datacenterCode: offer.dc, sizeGb: 10 }],
    ['post', '/api/instances', { name: 'i', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1 }],
  ];

  it('любое лишнее привилегированное поле в теле любого эндпоинта — 400, и ничего не меняется', async () => {
    const volumeId = (await a.api.post('/api/volumes', { name: 'ext', datacenterCode: offer.dc, sizeGb: 10 })).body.id;
    const before = await sql<{ role: string; status: string; balance: string; password_hash: string; email_verified_at: Date | null }>(
      'SELECT role, status, balance, password_hash, email_verified_at FROM users WHERE id = $1', [a.id],
    );
    const instancesBefore = (await sql<{ n: number }>('SELECT count(*)::int AS n FROM instances WHERE user_id = $1', [a.id]))[0]!.n;
    const endpoints = [...valid(), ['post', `/api/volumes/${volumeId}/extend`, { sizeGb: 20 }] as [string, string, object]];
    for (const [, url, body] of endpoints) {
      for (const [field, value] of Object.entries(privileged)) {
        const r = await a.api.post(url, { ...body, [field]: value });
        expect(r.status, `${url} + ${field}`).toBe(400);
      }
    }
    const after = await sql<typeof before[number]>('SELECT role, status, balance, password_hash, email_verified_at FROM users WHERE id = $1', [a.id]);
    expect(after).toEqual(before);
    expect(after[0]!.role).toBe('client');
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM instances WHERE user_id = $1', [a.id]))[0]!.n).toBe(instancesBefore);
    expect((await a.api.get('/api/auth/me')).body.user.role).toBe('client');
    expect((await a.api.get('/api/admin/users')).status).toBe(403);
  });

  it('прототипное загрязнение: __proto__ и constructor в JSON не дают прав и ничего не ломают', async () => {
    for (const raw of [
      '{"email":"proto-1@example.test","password":"longenough1","fullName":"Иван","__proto__":{"role":"admin"}}',
      '{"email":"proto-2@example.test","password":"longenough1","fullName":"Иван","constructor":{"prototype":{"role":"admin"}}}',
    ]) {
      const r = await bare(app).post('/api/auth/register').set('Content-Type', 'application/json').set('X-Requested-With', 'fetch').set('Origin', 'http://localhost:3000').set('X-Forwarded-For', '10.9.9.9').send(raw);
      expect(r.status).toBe(400);
    }
    expect(({} as Record<string, unknown>).role).toBeUndefined();
    expect(await sql("SELECT 1 FROM users WHERE email LIKE 'proto-%@example.test'")).toHaveLength(0);
  });

  it('SQL-инъекции в текстовых полях хранятся как данные и ничего не ломают', async () => {
    const evil = "Robert'); DROP TABLE users;--";
    const reg = await new Api(app).post('/api/auth/register', { email: `inj-${uniq()}@example.test`, password: 'longenough1', fullName: evil });
    expect(reg.status).toBe(201);
    expect(reg.body.user.fullName).toBe(evil);
    const tpl = await a.api.post('/api/templates', { name: evil, dockerImage: 'registry.example.com/x/y:1', defaultDiskGb: 20 });
    expect(tpl.status).toBe(201);
    expect(tpl.body.name).toBe(evil);
    const login = await new Api(app).post('/api/auth/login', { email: "' OR '1'='1' --@example.test", password: "' OR '1'='1" });
    expect(login.status).toBe(400); // не email
    const login2 = await new Api(app).post('/api/auth/login', { email: "a'b@example.test", password: "' OR '1'='1" });
    expect(login2.status).toBe(401);
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM users'))[0]!.n).toBeGreaterThan(50);
  });

  it('чужие данные через API недоступны ни одним из способов', async () => {
    // подробная матрица (404 как у несуществующих) — в isolation.test.ts; здесь только итог под настоящей ролью
    const asA = await a.api.get('/api/instances');
    expect(asA.body.every((i: { name: string }) => i.name !== 'steal')).toBe(true);
    expect((await a.api.get('/api/volumes')).body.every((v: { id: number }) => v.id !== res.volume)).toBe(true);
    const admin = await loginAs(app, ADMIN.email, ADMIN.password);
    expect((await admin.get('/api/volumes')).body.every((v: { id: number }) => v.id !== res.volume)).toBe(true); // даже админу чужие тома в «моих» не попадают
  });
});

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../../src/auth/tokens';
import { makeSshKey } from '../support/ssh';
import { Api, closeAll, launch, loginAs, makeApp, newUser, pickOffer, bare, sql, uniq } from './helpers';
import type { Offer, TestUser } from './helpers';

const app = makeApp();
let user: TestUser;
let offer: Offer;

beforeAll(async () => {
  user = await newUser(app, { balance: 5000 });
  offer = await pickOffer(app, 8);
});
afterAll(closeAll);

const withKey = (key: string): Api => {
  const api = new Api(app);
  api.bearer = key;
  return api;
};

describe('SSH-ключи', () => {
  it('201: отпечаток SHA256 совпадает с ssh-keygen -l (считаем независимо), ключ в списке', async () => {
    const k = makeSshKey('me@laptop');
    const res = await user.api.post('/api/ssh-keys', { name: 'laptop', publicKey: k.publicKey });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(Number), name: 'laptop', fingerprint: k.fingerprint, publicKey: k.publicKey, createdAt: expect.any(String) });
    expect(res.headers['cache-control']).toBe('private, no-store');
    const list = await user.api.get('/api/ssh-keys');
    expect(list.body.some((x: { id: number }) => x.id === res.body.id)).toBe(true);
  });

  it('тот же ключ дважды — 409 SSH_KEY_EXISTS; другой пользователь может добавить такой же ключ', async () => {
    const u = await newUser(app);
    const k = makeSshKey();
    expect((await u.api.post('/api/ssh-keys', { name: 'a', publicKey: k.publicKey })).status).toBe(201);
    const dup = await u.api.post('/api/ssh-keys', { name: 'b', publicKey: k.publicKey + ' ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SSH_KEY_EXISTS');
    const other = await newUser(app);
    expect((await other.api.post('/api/ssh-keys', { name: 'a', publicKey: k.publicKey })).status).toBe(201);
  });

  it('не публичный ключ, закрытый ключ и мусор отклоняются; лишние поля — тоже', async () => {
    const bad = ['hello world', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ', 'x'.repeat(30)];
    for (const publicKey of bad) {
      const res = await user.api.post('/api/ssh-keys', { name: 'bad', publicKey });
      expect(res.status, publicKey).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const k = makeSshKey();
    expect((await user.api.post('/api/ssh-keys', { name: 'k', publicKey: k.publicKey, userId: 1 })).status).toBe(400);
    expect((await user.api.post('/api/ssh-keys', { name: '', publicKey: k.publicKey })).status).toBe(400);
  });

  it('удаление: свой — 204, повторно — 404; у инстанса ссылка на ключ обнуляется', async () => {
    const u = await newUser(app, { balance: 5000 });
    const created = await u.api.post('/api/ssh-keys', { name: 'deploy', publicKey: makeSshKey().publicKey });
    const run = await launch(u, offer, { sshKeyId: created.body.id });
    expect(run.body.sshKey).toEqual({ id: created.body.id, name: 'deploy' });

    expect((await u.api.delete(`/api/ssh-keys/${created.body.id}`)).status).toBe(204);
    expect((await u.api.delete(`/api/ssh-keys/${created.body.id}`)).status).toBe(404);
    const after = await u.api.get(`/api/instances/${run.id}`);
    expect(after.status).toBe(200);
    expect(after.body.sshKey).toBeNull();
  });

  it('чужой ключ нельзя использовать при запуске, и ответ не отличается от ответа на несуществующий id', async () => {
    const owner = await newUser(app);
    const mine = await owner.api.post('/api/ssh-keys', { name: 'secret', publicKey: makeSshKey().publicKey });
    const thief = await newUser(app, { balance: 5000 });
    const foreign = await thief.api.post('/api/instances', { name: 'x', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1, sshKeyId: mine.body.id });
    const missing = await thief.api.post('/api/instances', { name: 'x', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: 1, sshKeyId: 99_999_999 });
    expect(foreign.status).toBe(missing.status);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.body).toEqual(missing.body);
    expect(await sql('SELECT 1 FROM instances WHERE user_id = $1', [thief.id])).toHaveLength(0);
  });

  it('не больше 20 ключей на пользователя: 21-й — 409 LIMIT_REACHED', async () => {
    const u = await newUser(app);
    for (let i = 0; i < 20; i++) expect((await u.api.post('/api/ssh-keys', { name: `k${i}`, publicKey: makeSshKey().publicKey })).status).toBe(201);
    const res = await u.api.post('/api/ssh-keys', { name: 'k21', publicKey: makeSshKey().publicKey });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LIMIT_REACHED');
  });

  it('без входа — 401', async () => {
    expect((await new Api(app).get('/api/ssh-keys')).status).toBe(401);
  });
});

describe('API-ключи', () => {
  it('201: ключ показывается один раз; в БД только SHA-256; в списке ключа и хэша нет', async () => {
    const res = await user.api.post('/api/api-keys', { name: 'ci' });
    expect(res.status).toBe(201);
    const key: string = res.body.key;
    expect(key).toMatch(/^gr_[A-Za-z0-9_-]{43}$/);
    expect(res.body.apiKey).toEqual({
      id: expect.any(Number), name: 'ci', prefix: key.slice(0, 8), createdAt: expect.any(String), lastUsedAt: null, expiresAt: null, revokedAt: null,
    });
    const [row] = await sql<{ key_hash: Buffer; key_prefix: string }>('SELECT key_hash, key_prefix FROM api_keys WHERE id = $1', [res.body.apiKey.id]);
    expect(row!.key_hash.equals(createHash('sha256').update(key).digest())).toBe(true);
    expect(row!.key_prefix).toBe(key.slice(0, 8));

    const list = await user.api.get('/api/api-keys');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(JSON.stringify(list.body)).not.toMatch(/hash|"key"/i);
    expect(list.body.find((k: { id: number }) => k.id === res.body.apiKey.id).prefix).toBe(key.slice(0, 8));
  });

  it('вход по Bearer: личность, список инстансов, запуск и остановка без CSRF-заголовков; last_used_at обновляется', async () => {
    const u = await newUser(app, { balance: 5000 });
    const created = await u.api.post('/api/api-keys', { name: 'bot' });
    const bot = withKey(created.body.key);

    const me = await bot.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(u.id);

    const started = await bot.post('/api/instances', { name: 'by-key', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'spot', templateId: 1 }, { csrf: false });
    expect(started.status).toBe(201);
    expect((await bot.get('/api/instances')).body).toHaveLength(1);
    expect((await bot.post(`/api/instances/${started.body.id}/stop`, undefined, { csrf: false })).status).toBe(200);

    const [row] = await sql<{ last_used_at: Date | null }>('SELECT last_used_at FROM api_keys WHERE id = $1', [created.body.apiKey.id]);
    expect(row!.last_used_at).not.toBeNull();
  });

  it('создание и отзыв ключей, смена пароля по Bearer — 403 SESSION_REQUIRED', async () => {
    const u = await newUser(app);
    const created = await u.api.post('/api/api-keys', { name: 'bot' });
    const bot = withKey(created.body.key);
    for (const res of [
      await bot.post('/api/api-keys', { name: 'new' }, { csrf: false }),
      await bot.delete(`/api/api-keys/${created.body.apiKey.id}`, { csrf: false }),
      await bot.post('/api/auth/password', { currentPassword: u.password, newPassword: 'another-password-1' }, { csrf: false }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SESSION_REQUIRED');
    }
    expect((await bot.get('/api/auth/me')).status).toBe(200); // сам ключ не пострадал
  });

  it('отозванный ключ — 401; повторный отзыв не ошибка и не дублирует аудит', async () => {
    const u = await newUser(app);
    const created = await u.api.post('/api/api-keys', { name: 'bot' });
    const bot = withKey(created.body.key);
    expect((await bot.get('/api/auth/me')).status).toBe(200);

    expect((await u.api.delete(`/api/api-keys/${created.body.apiKey.id}`)).status).toBe(204);
    const res = await bot.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_API_KEY');

    expect((await u.api.delete(`/api/api-keys/${created.body.apiKey.id}`)).status).toBe(204);
    const audit = await sql("SELECT ip FROM audit_log WHERE action = 'api_key.revoked' AND entity_id = $1", [String(created.body.apiKey.id)]);
    expect(audit).toHaveLength(1);
    const listed = (await u.api.get('/api/api-keys')).body.find((k: { id: number }) => k.id === created.body.apiKey.id);
    expect(listed.revokedAt).not.toBeNull();
  });

  it('создание и отзыв попадают в журнал аудита вместе с IP клиента', async () => {
    const u = await newUser(app);
    const created = await u.api.post('/api/api-keys', { name: 'audited' });
    await u.api.delete(`/api/api-keys/${created.body.apiKey.id}`);
    const rows = await sql<{ action: string; ip: string; actor_user_id: number }>(
      "SELECT action, host(ip) AS ip, actor_user_id FROM audit_log WHERE entity = 'api_keys' AND entity_id = $1 ORDER BY id", [String(created.body.apiKey.id)],
    );
    expect(rows.map((r) => r.action)).toEqual(['api_key.created', 'api_key.revoked']);
    expect(rows.every((r) => r.ip === u.api.ip && r.actor_user_id === u.id)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(created.body.key);
  });

  it('срок действия: будущий принимается, прошедший — 400, истёкший ключ — 401', async () => {
    const u = await newUser(app);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const ok = await u.api.post('/api/api-keys', { name: 'temp', expiresAt: future });
    expect(ok.status).toBe(201);
    expect(ok.body.apiKey.expiresAt).toBe(future);
    expect((await u.api.post('/api/api-keys', { name: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);

    const bot = withKey(ok.body.key);
    expect((await bot.get('/api/auth/me')).status).toBe(200);
    await sql("UPDATE api_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1", [ok.body.apiKey.id]);
    expect((await bot.get('/api/auth/me')).status).toBe(401);
  });

  it('неверные заголовки Authorization — 401, а не пропуск без входа', async () => {
    const valid = generateApiKey().key; // верного формата, но в БД такого ключа нет
    const headers = ['Bearer', 'Bearer ', 'Bearer abc', `Bearer ${valid}`, `bearer ${valid}`, `Token ${valid}`, `Bearer ${valid} extra`, `Bearer gr_${'!'.repeat(43)}`];
    for (const h of headers) {
      const res = await bare(app).get('/api/auth/me').set('Authorization', h);
      expect(res.status, h).toBe(401);
    }
  });

  it('Bearer сильнее cookie: ключ A при сессии B действует как A; неверный ключ при сессии B не даёт доступа', async () => {
    const a = await newUser(app);
    const b = await newUser(app);
    const keyA = await a.api.post('/api/api-keys', { name: 'a' });
    const res = await b.api.get('/api/auth/me', { headers: { Authorization: `Bearer ${keyA.body.key}` } });
    expect(res.body.user.id).toBe(a.id);
    const bad = await b.api.get('/api/auth/me', { headers: { Authorization: `Bearer ${generateApiKey().key}` } });
    expect(bad.status).toBe(401);
  });

  it('не больше 10 действующих ключей; после отзыва место освобождается', async () => {
    const u = await newUser(app);
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await u.api.post('/api/api-keys', { name: `k${i}` });
      expect(r.status).toBe(201);
      ids.push(r.body.apiKey.id);
    }
    const over = await u.api.post('/api/api-keys', { name: 'k11' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('LIMIT_REACHED');
    await u.api.delete(`/api/api-keys/${ids[0]}`);
    expect((await u.api.post('/api/api-keys', { name: 'k11' })).status).toBe(201);
  });

  it('чужой ключ отозвать нельзя (404); лишние поля при создании — 400', async () => {
    const a = await newUser(app);
    const b = await newUser(app);
    const keyA = await a.api.post('/api/api-keys', { name: 'a' });
    expect((await b.api.delete(`/api/api-keys/${keyA.body.apiKey.id}`)).status).toBe(404);
    expect((await withKey(keyA.body.key).get('/api/auth/me')).status).toBe(200);
    expect((await a.api.post('/api/api-keys', { name: 'x', userId: b.id })).status).toBe(400);
    expect((await a.api.post('/api/api-keys', { name: 'x', keyHash: 'abc' })).status).toBe(400);
  });

  it('вход по Bearer не создаёт сессий и cookie', async () => {
    const u = await newUser(app);
    const created = await u.api.post('/api/api-keys', { name: 'bot' });
    const before = await sql<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id]);
    const res = await withKey(created.body.key).get('/api/auth/me');
    expect(res.headers['set-cookie']).toBeUndefined();
    const after = await sql<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id]);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('личные шаблоны', () => {
  const body = (over: Record<string, unknown> = {}) => ({ name: `tpl-${uniq()}`, dockerImage: 'registry.example.com/team/env:1.0', defaultDiskGb: 40, defaultPorts: '22/tcp,8888/http', ...over });

  it('201: приватный шаблон принадлежит автору и виден только ему в /templates/mine', async () => {
    const u = await newUser(app);
    const other = await newUser(app);
    const res = await u.api.post('/api/templates', body({ name: 'mine' }));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(Number), name: 'mine', dockerImage: 'registry.example.com/team/env:1.0', defaultDiskGb: 40, defaultPorts: '22/tcp,8888/http', isPublic: false });

    const [row] = await sql<{ owner_id: number; is_public: boolean }>('SELECT owner_id, is_public FROM templates WHERE id = $1', [res.body.id]);
    expect(row).toEqual({ owner_id: u.id, is_public: false });
    expect((await u.api.get('/api/templates/mine')).body.map((t: { id: number }) => t.id)).toEqual([res.body.id]);
    expect((await other.api.get('/api/templates/mine')).body).toEqual([]);
    expect((await new Api(app).get('/api/templates/mine')).status).toBe(401);
  });

  it.each([['isPublic', true], ['is_public', true], ['ownerId', 1], ['owner_id', null], ['id', 1]])('поле %s из тела не принимается: публичный или чужой шаблон создать нельзя', async (field, value) => {
    const res = await user.api.post('/api/templates', body({ [field]: value }));
    expect(res.status).toBe(400);
  });

  it('запуск со своим шаблоном работает, с чужим — 404; шаблон, на который ссылается инстанс, не удаляется (409)', async () => {
    const owner = await newUser(app, { balance: 5000 });
    const thief = await newUser(app, { balance: 5000 });
    const tpl = await owner.api.post('/api/templates', body());
    const mine = await launch(owner, offer, { templateId: tpl.body.id });
    expect(mine.body.template).toEqual({ id: tpl.body.id, name: tpl.body.name });

    const stolen = await thief.api.post('/api/instances', { name: 'x', datacenterCode: offer.dc, gpuModel: offer.model, gpuCount: 1, pricingType: 'on_demand', templateId: tpl.body.id });
    expect(stolen.status).toBe(404);

    const busy = await owner.api.delete(`/api/templates/${tpl.body.id}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('TEMPLATE_IN_USE');
  });

  it('удаление: свой — 204; чужой и публичный — 404', async () => {
    const owner = await newUser(app);
    const other = await newUser(app);
    const tpl = await owner.api.post('/api/templates', body());
    expect((await other.api.delete(`/api/templates/${tpl.body.id}`)).status).toBe(404);
    expect((await owner.api.delete('/api/templates/1')).status).toBe(404); // публичный шаблон каталога
    expect(await sql('SELECT 1 FROM templates WHERE id = 1')).toHaveLength(1);
    expect((await owner.api.delete(`/api/templates/${tpl.body.id}`)).status).toBe(204);
    expect((await owner.api.get('/api/templates/mine')).body).toEqual([]);
  });

  it('проверка входных данных и лимит 20 шаблонов', async () => {
    const u = await newUser(app);
    for (const bad of [{ name: '' }, { dockerImage: 'bad image name' }, { dockerImage: '-rm' }, { defaultDiskGb: 5 }, { defaultDiskGb: 5000 }, { defaultPorts: 'any' }, { defaultPorts: '99999999/tcp' }]) {
      expect((await u.api.post('/api/templates', body(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    for (let i = 0; i < 20; i++) expect((await u.api.post('/api/templates', body())).status).toBe(201);
    const res = await u.api.post('/api/templates', body());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LIMIT_REACHED');
  });
});

describe('вход администратора по ключу', () => {
  it('ключ администратора читает админ-эндпоинты, но менять данные им нельзя (SESSION_REQUIRED)', async () => {
    const adminSession = await loginAs(app, 'admin@gpu-rent.example', process.env.TEST_ADMIN_PASSWORD ?? 'admin-test-12345');
    const created = await adminSession.post('/api/api-keys', { name: 'admin-bot' });
    expect(created.status).toBe(201);
    const bot = withKey(created.body.key);
    expect((await bot.get('/api/admin/users')).status).toBe(200);
    const write = await bot.post('/api/admin/prices', { datacenterCode: offer.dc, gpuModel: offer.model, pricingType: 'spot', pricePerHour: 50 }, { csrf: false });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('SESSION_REQUIRED');
    await adminSession.delete(`/api/api-keys/${created.body.apiKey.id}`);
  });
});

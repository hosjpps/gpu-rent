import { createHash } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, Api, ORIGIN, USER_PASSWORD, closeAll, loginAs, makeApp, newUser, randomIp, bare, sql, tokenFromLink, uniqEmail } from './helpers';

const app = makeApp();
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const sessionCookie = (res: Response): string => {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('sid='));
  if (!raw) throw new Error('в ответе нет cookie sid');
  return raw;
};

afterAll(closeAll);

describe('регистрация', () => {
  it('создаёт клиента без прав и баланса, ссылка подтверждения приходит в ответе (демо-режим)', async () => {
    const email = uniqEmail('reg');
    const res = await new Api(app).post('/api/auth/register', { email, password: USER_PASSWORD, fullName: 'Иван Петров' });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      email,
      fullName: 'Иван Петров',
      role: 'client',
      status: 'active',
      balance: '0.0000',
      emailVerified: false,
    });
    expect(res.headers['set-cookie']).toBeUndefined(); // вход после регистрации — отдельный шаг
    expect(res.headers['cache-control']).toBe('private, no-store');
    // фронтенд читает именно verifyUrl и открывает страницу /verify?token=...
    expect(res.body.verifyUrl).toMatch(new RegExp(`^${ORIGIN}/verify\\?token=[A-Za-z0-9_-]{43}$`));
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it('в БД лежит bcrypt-хэш пароля и SHA-256 токена, но не они сами', async () => {
    const email = uniqEmail('reg');
    const res = await new Api(app).post('/api/auth/register', { email, password: USER_PASSWORD, fullName: 'Иван Петров' });
    const token = tokenFromLink(res.body.verifyUrl);
    const [u] = await sql<{ password_hash: string; role: string }>('SELECT password_hash, role FROM users WHERE id = $1', [res.body.user.id]);
    expect(u!.password_hash).toMatch(/^\$2[aby]\$/);
    expect(u!.password_hash).not.toContain(USER_PASSWORD);
    expect(u!.role).toBe('client');
    const [t] = await sql<{ hex: string }>("SELECT encode(token_hash, 'hex') AS hex FROM email_tokens WHERE user_id = $1", [res.body.user.id]);
    expect(t!.hex).toBe(sha256hex(token));
  });

  it('email приводится к нижнему регистру и обрезается; повтор в другом регистре — 409', async () => {
    const email = uniqEmail('Case');
    const first = await new Api(app).post('/api/auth/register', { email: `  ${email.toUpperCase()} `, password: USER_PASSWORD, fullName: 'Иван Петров' });
    expect(first.status).toBe(201);
    expect(first.body.user.email).toBe(email.toLowerCase());
    const dup = await new Api(app).post('/api/auth/register', { email, password: USER_PASSWORD, fullName: 'Другой Человек' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('некорректные данные — 400 с перечнем полей и ничего не создаётся', async () => {
    const email = uniqEmail('bad');
    const res = await new Api(app).post('/api/auth/register', { email, password: 'short', fullName: 'И' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['fullName', 'password']);
    expect(await sql('SELECT 1 FROM users WHERE email = $1', [email])).toHaveLength(0);
  });

  it.each([
    ['role', 'admin'],
    ['status', 'active'],
    ['balance', '1000000'],
    ['emailVerified', true],
    ['id', 1],
  ])('лишнее поле %s отклоняется: пользователь не может назначить себе права или баланс', async (field, value) => {
    const email = uniqEmail('priv');
    const res = await new Api(app).post('/api/auth/register', { email, password: USER_PASSWORD, fullName: 'Иван Петров', [field]: value });
    expect(res.status).toBe(400);
    expect(await sql('SELECT 1 FROM users WHERE email = $1', [email])).toHaveLength(0);
  });

  it('без DEMO_MAIL ссылка подтверждения в ответе не отдаётся (письма-то не шлются, но и токен не светится)', async () => {
    const prod = makeApp({ DEMO_MAIL: '0' });
    const res = await new Api(prod).post('/api/auth/register', { email: uniqEmail('nomail'), password: USER_PASSWORD, fullName: 'Иван Петров' });
    expect(res.status).toBe(201);
    expect(res.body.verifyUrl).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it('лимит регистраций с одного IP: после превышения — 429 и Retry-After', async () => {
    const limited = makeApp({ AUTH_REGISTER_IP_MAX: '2' });
    const ip = randomIp();
    for (let i = 0; i < 2; i++) {
      const ok = await new Api(limited, ip).post('/api/auth/register', { email: uniqEmail('lim'), password: USER_PASSWORD, fullName: 'Иван Петров' });
      expect(ok.status).toBe(201);
    }
    const res = await new Api(limited, ip).post('/api/auth/register', { email: uniqEmail('lim'), password: USER_PASSWORD, fullName: 'Иван Петров' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // другой адрес не затронут
    const other = await new Api(limited, randomIp()).post('/api/auth/register', { email: uniqEmail('lim'), password: USER_PASSWORD, fullName: 'Иван Петров' });
    expect(other.status).toBe(201);
  });
});

describe('подтверждение email', () => {
  it('ссылка подтверждает адрес один раз; повтор и выдуманный токен — 400', async () => {
    const u = await newUser(app, { verify: false });
    expect((await u.api.get('/api/auth/me')).body.user.emailVerified).toBe(false);

    const resend = await u.api.post('/api/auth/resend');
    expect(resend.status).toBe(200);
    const token = tokenFromLink(resend.body.verifyUrl);

    const anon = new Api(app); // ссылка из письма открывается и без входа
    const ok = await anon.post('/api/auth/verify', { token });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ verified: true });
    expect((await u.api.get('/api/auth/me')).body.user.emailVerified).toBe(true);

    const again = await anon.post('/api/auth/verify', { token });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
    const fake = await anon.post('/api/auth/verify', { token: 'x'.repeat(43) });
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('INVALID_TOKEN');
    const garbage = await anon.post('/api/auth/verify', { token: 'abc' });
    expect(garbage.status).toBe(400);
    expect(garbage.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('просроченная ссылка не работает', async () => {
    const u = await newUser(app, { verify: false });
    const resend = await u.api.post('/api/auth/resend');
    await sql("UPDATE email_tokens SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE user_id = $1", [u.id]);
    const res = await new Api(app).post('/api/auth/verify', { token: tokenFromLink(resend.body.verifyUrl) });
    expect(res.status).toBe(400);
    expect((await u.api.get('/api/auth/me')).body.user.emailVerified).toBe(false);
  });

  it('повторная отправка отменяет старую ссылку', async () => {
    const u = await newUser(app, { verify: false });
    const first = await u.api.post('/api/auth/resend');
    const second = await u.api.post('/api/auth/resend');
    const old = await new Api(app).post('/api/auth/verify', { token: tokenFromLink(first.body.verifyUrl) });
    expect(old.status).toBe(400);
    const fresh = await new Api(app).post('/api/auth/verify', { token: tokenFromLink(second.body.verifyUrl) });
    expect(fresh.status).toBe(200);
  });

  it('повторная отправка требует входа; для подтверждённого адреса — 409; частота ограничена', async () => {
    expect((await new Api(app).post('/api/auth/resend')).status).toBe(401);

    const verified = await newUser(app);
    const res = await verified.api.post('/api/auth/resend');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');

    const u = await newUser(app, { verify: false });
    for (let i = 0; i < 5; i++) expect((await u.api.post('/api/auth/resend')).status).toBe(200);
    const limited = await u.api.post('/api/auth/resend');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('вход и выход', () => {
  it('вход выдаёт cookie сессии: HttpOnly, SameSite=Lax, на 7 дней; в БД только SHA-256 токена', async () => {
    const u = await newUser(app, { login: false });
    const api = new Api(app);
    const res = await api.post('/api/auth/login', { email: u.email, password: u.password });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: u.id, email: u.email, role: 'client', status: 'active', emailVerified: true });
    expect(res.headers['cache-control']).toBe('private, no-store');

    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/i); // тестовое окружение — не production
    const expires = Date.parse(/Expires=([^;]+)/i.exec(cookie)![1]!);
    const days = (expires - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const token = /^sid=([^;]+)/.exec(cookie)![1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await sql<{ hex: string }>("SELECT encode(token_hash, 'hex') AS hex FROM sessions WHERE user_id = $1", [u.id]);
    expect(rows.map((r) => r.hex)).toContain(sha256hex(token));
    expect(rows.map((r) => r.hex)).not.toContain(token);
  });

  it('в production cookie называется __Host-sid и помечена Secure; заголовок HSTS включён', async () => {
    const prod = makeApp({ NODE_ENV: 'production' });
    const u = await newUser(app, { login: false });
    const res = await new Api(prod).post('/api/auth/login', { email: u.email, password: u.password });
    expect(res.status).toBe(200);
    const raw = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(raw).toMatch(/^__Host-sid=/);
    expect(raw).toMatch(/; Secure/i);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Domain=/i);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  it('неверный пароль и несуществующий email дают один и тот же ответ', async () => {
    const u = await newUser(app, { login: false });
    const wrongPass = await new Api(app).post('/api/auth/login', { email: u.email, password: 'wrong-password' });
    const noUser = await new Api(app).post('/api/auth/login', { email: uniqEmail('nobody'), password: 'wrong-password' });
    expect(wrongPass.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPass.body).toEqual(noUser.body);
    expect(wrongPass.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPass.headers['set-cookie']).toBeUndefined();
  });

  it('seed-пользователи без известного пароля войти не могут', async () => {
    const res = await new Api(app).post('/api/auth/login', { email: 'user0003@example.com', password: USER_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('/me без входа — 401, после входа — свой пользователь', async () => {
    const u = await newUser(app);
    expect((await new Api(app).get('/api/auth/me')).status).toBe(401);
    const me = await u.api.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(u.id);
    expect(me.headers['cache-control']).toBe('private, no-store');
  });

  it('выход удаляет сессию в БД: украденная cookie после выхода бесполезна', async () => {
    const u = await newUser(app, { login: false });
    const api = new Api(app);
    const login = await api.post('/api/auth/login', { email: u.email, password: u.password });
    const stolen = sessionCookie(login).split(';')[0]!;
    const before = await sql<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id]);

    const out = await api.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect(sessionCookie(out)).toMatch(/^sid=;/); // cookie сброшена в браузере
    const after = await sql<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id]);
    expect(after[0]!.n).toBe(before[0]!.n - 1);

    expect((await api.get('/api/auth/me')).status).toBe(401);
    const replay = await bare(app).get('/api/auth/me').set('Cookie', stolen);
    expect(replay.status).toBe(401);
  });

  it('выход без сессии не ошибка; но CSRF-защита действует и здесь', async () => {
    expect((await new Api(app).post('/api/auth/logout')).status).toBe(200);
    expect((await new Api(app).post('/api/auth/logout', undefined, { csrf: false })).status).toBe(403);
  });

  it('выход на одном устройстве не трогает сессию на другом', async () => {
    const u = await newUser(app);
    const other = await loginAs(app, u.email, u.password);
    await u.api.post('/api/auth/logout');
    expect((await other.get('/api/auth/me')).status).toBe(200);
  });

  it('просроченная сессия — 401 и cookie сбрасывается', async () => {
    const u = await newUser(app, { login: false });
    const api = new Api(app);
    const login = await api.post('/api/auth/login', { email: u.email, password: u.password });
    const cookie = sessionCookie(login).split(';')[0]!;
    await sql("UPDATE sessions SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE user_id = $1", [u.id]);
    const res = await bare(app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  it('сессия скользящая: после 10 минут простоя срок продлевается и cookie выдаётся заново', async () => {
    const u = await newUser(app, { login: false });
    const api = new Api(app);
    const login = await api.post('/api/auth/login', { email: u.email, password: u.password });
    const cookie = sessionCookie(login).split(';')[0]!;

    const fresh = await bare(app).get('/api/auth/me').set('Cookie', cookie);
    expect(fresh.status).toBe(200);
    expect(fresh.headers['set-cookie']).toBeUndefined(); // недавно виделись: запись в БД не нужна

    await sql("UPDATE sessions SET last_seen_at = now() - interval '11 minutes', expires_at = now() + interval '1 day' WHERE user_id = $1", [u.id]);
    const renewed = await bare(app).get('/api/auth/me').set('Cookie', cookie);
    expect(renewed.status).toBe(200);
    const days = (Date.parse(/Expires=([^;]+)/i.exec(sessionCookie(renewed))![1]!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
  });

  it('неверный Bearer не подхватывает чужую сессию из cookie', async () => {
    const u = await newUser(app);
    u.api.bearer = 'gr_' + 'A'.repeat(43);
    const res = await u.api.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_API_KEY');
  });
});

describe('странные cookie и заголовки', () => {
  it('битое %-кодирование, пустое значение и мусор в cookie — это «нет сессии» (401), а не 500', async () => {
    for (const cookie of ['sid=%', 'sid=%E0%A4%A', 'sid=', 'sid', ';;;===', `sid=${'a'.repeat(5000)}`, 'sid=%00']) {
      const res = await bare(app).get('/api/auth/me').set('Cookie', cookie);
      expect(res.status, cookie.slice(0, 20)).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('публичные адреса с такой cookie отвечают как обычно', async () => {
    const res = await bare(app).get('/api/catalog/gpus').set('Cookie', 'sid=%');
    expect(res.status).toBe(200);
  });
});

describe('ограничение частоты входа', () => {
  it('после 10 неверных попыток с одного адреса — 429 с Retry-After, даже с верным паролем; другой email не затронут', async () => {
    const u = await newUser(app, { login: false });
    const other = await newUser(app, { login: false });
    const ip = randomIp();
    for (let i = 1; i <= 10; i++) {
      const r = await new Api(app, ip).post('/api/auth/login', { email: u.email, password: `wrong-${i}-password` });
      expect(r.status, `попытка ${i}`).toBe(401);
    }
    const blocked = await new Api(app, ip).post('/api/auth/login', { email: u.email, password: `wrong-11-password` });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    const retry = Number(blocked.headers['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(900);

    const correct = await new Api(app, ip).post('/api/auth/login', { email: u.email, password: u.password });
    expect(correct.status).toBe(429); // подбор не должен «выиграть» после лимита

    const fine = await new Api(app, ip).post('/api/auth/login', { email: other.email, password: other.password });
    expect(fine.status).toBe(200);
  });

  it('чужой адрес не может запереть владельца: неверные попытки с другого IP не мешают войти с верным паролем', async () => {
    const victim = await newUser(app, { login: false });
    const attacker = randomIp();
    for (let i = 1; i <= 12; i++) {
      await new Api(app, attacker).post('/api/auth/login', { email: victim.email, password: `wrong-${i}-password` });
    }
    expect((await new Api(app, attacker).post('/api/auth/login', { email: victim.email, password: victim.password })).status).toBe(429);
    // владелец с обычного для него адреса входит без помех
    expect((await new Api(app, randomIp()).post('/api/auth/login', { email: victim.email, password: victim.password })).status).toBe(200);
  });

  it('общий лимит на email с разных адресов защищает от распределённого подбора', async () => {
    const limited = makeApp({ AUTH_LOGIN_EMAIL_MAX: '5', AUTH_LOGIN_EMAIL_IP_MAX: '100' });
    const u = await newUser(limited, { login: false });
    for (let i = 1; i <= 5; i++) {
      expect((await new Api(limited, randomIp()).post('/api/auth/login', { email: u.email, password: `wrong-${i}-password` })).status).toBe(401);
    }
    const blocked = await new Api(limited, randomIp()).post('/api/auth/login', { email: u.email, password: u.password });
    expect(blocked.status).toBe(429);
  });

  it('успешный вход сбрасывает счётчик неудач', async () => {
    const u = await newUser(app, { login: false });
    const ip = randomIp();
    for (let i = 0; i < 9; i++) expect((await new Api(app, ip).post('/api/auth/login', { email: u.email, password: 'wrong-password-x' })).status).toBe(401);
    expect((await new Api(app, ip).post('/api/auth/login', { email: u.email, password: u.password })).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await new Api(app, ip).post('/api/auth/login', { email: u.email, password: 'wrong-password-x' })).status).toBe(401);
  });

  it('счётчик живёт в БД, а не в памяти приложения: второй экземпляр приложения видит те же попытки', async () => {
    const u = await newUser(app, { login: false });
    const ip = randomIp();
    for (let i = 0; i < 10; i++) await new Api(app, ip).post('/api/auth/login', { email: u.email, password: 'wrong-password-x' });
    const secondInstance = makeApp();
    const res = await new Api(secondInstance, ip).post('/api/auth/login', { email: u.email, password: u.password });
    expect(res.status).toBe(429);
  });

  it('лимит по IP: подбор разных адресов с одного IP тоже останавливается', async () => {
    const limited = makeApp({ AUTH_LOGIN_IP_MAX: '3' });
    const ip = randomIp();
    for (let i = 0; i < 3; i++) expect((await new Api(limited, ip).post('/api/auth/login', { email: uniqEmail('x'), password: 'wrong-password-x' })).status).toBe(401);
    const res = await new Api(limited, ip).post('/api/auth/login', { email: uniqEmail('x'), password: 'wrong-password-x' });
    expect(res.status).toBe(429);
    expect((await new Api(limited, randomIp()).post('/api/auth/login', { email: uniqEmail('x'), password: 'wrong-password-x' })).status).toBe(401);
  });

  it('вход требует X-Requested-With и Origin (защита от login-CSRF)', async () => {
    const u = await newUser(app, { login: false });
    const noHeader = await new Api(app).post('/api/auth/login', { email: u.email, password: u.password }, { csrf: false });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error.code).toBe('CSRF');
    expect(noHeader.headers['set-cookie']).toBeUndefined();
  });
});

describe('адрес клиента для лимитов', () => {
  it('локальный запуск (прокси не доверенный): X-Forwarded-For не позволяет обойти лимит по IP', async () => {
    const local = makeApp({ VERCEL: undefined, AUTH_LOGIN_IP_MAX: '3' });
    const attempt = (xff: string) => bare(local).post('/api/auth/login').set('X-Requested-With', 'fetch').set('Origin', ORIGIN).set('X-Forwarded-For', xff).send({ email: uniqEmail('xff'), password: 'wrong-password-x' });
    for (let i = 0; i < 3; i++) expect((await attempt(`198.51.100.${i + 1}`)).status).toBe(401);
    expect((await attempt('198.51.100.99')).status).toBe(429); // у всех запросов один настоящий адрес сокета
  });

  it('на Vercel (одна доверенная прокси) считается последний адрес цепочки: подделанные левые адреса не помогают', async () => {
    const limited = makeApp({ AUTH_LOGIN_IP_MAX: '2' });
    const real = randomIp();
    const attempt = (spoofed: string) => bare(limited).post('/api/auth/login').set('X-Requested-With', 'fetch').set('Origin', ORIGIN).set('X-Forwarded-For', `${spoofed}, ${real}`).send({ email: uniqEmail('xff'), password: 'wrong-password-x' });
    expect((await attempt('1.1.1.1')).status).toBe(401);
    expect((await attempt('2.2.2.2')).status).toBe(401);
    expect((await attempt('3.3.3.3')).status).toBe(429);
  });
});

describe('смена пароля', () => {
  it('сбрасывает все остальные сессии, текущая получает новый токен; старый пароль не работает', async () => {
    const u = await newUser(app);
    const phone = await loginAs(app, u.email, u.password);
    const laptop = await loginAs(app, u.email, u.password);
    const sessionsBefore = (await sql<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id]))[0]!.n;
    expect(sessionsBefore).toBe(3);

    const res = await u.api.post('/api/auth/password', { currentPassword: u.password, newPassword: 'brand-new-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(u.id);
    expect(sessionCookie(res)).toMatch(/^sid=/); // новый токен для текущего браузера

    expect((await phone.get('/api/auth/me')).status).toBe(401);
    expect((await laptop.get('/api/auth/me')).status).toBe(401);
    expect((await u.api.get('/api/auth/me')).status).toBe(200);
    expect((await sql<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [u.id]))[0]!.n).toBe(1);

    expect((await new Api(app).post('/api/auth/login', { email: u.email, password: u.password })).status).toBe(401);
    expect((await new Api(app).post('/api/auth/login', { email: u.email, password: 'brand-new-password-1' })).status).toBe(200);

    const audit = await sql("SELECT 1 FROM audit_log WHERE action = 'user.password_changed' AND actor_user_id = $1", [u.id]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('отзывает действующие API-ключи, сообщает их число и пишет его в аудит; ключи других пользователей целы', async () => {
    const u = await newUser(app);
    const stranger = await newUser(app);
    const keys: string[] = [];
    for (const name of ['ci', 'bot']) keys.push((await u.api.post('/api/api-keys', { name })).body.key);
    const strangerKey: string = (await stranger.api.post('/api/api-keys', { name: 'ci' })).body.key;
    const bearer = (k: string): Api => Object.assign(new Api(app), { bearer: k });
    for (const k of keys) expect((await bearer(k).get('/api/auth/me')).status).toBe(200);

    const res = await u.api.post('/api/auth/password', { currentPassword: u.password, newPassword: 'brand-new-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.apiKeysRevoked).toBe(2);
    for (const k of keys) expect((await bearer(k).get('/api/auth/me')).status, 'отозванный ключ').toBe(401);
    expect((await bearer(strangerKey).get('/api/auth/me')).status).toBe(200);

    const audit = await sql<{ details: { api_keys_revoked: number } }>("SELECT details FROM audit_log WHERE action = 'user.password_changed' AND actor_user_id = $1 ORDER BY id DESC LIMIT 1", [u.id]);
    expect(audit[0]!.details.api_keys_revoked).toBe(2);

    const none = await u.api.post('/api/auth/password', { currentPassword: 'brand-new-password-1', newPassword: 'brand-new-password-2' });
    expect(none.body.apiKeysRevoked).toBe(0);
  });

  it('неверный текущий пароль — 401, сессии остаются, пароль прежний', async () => {
    const u = await newUser(app);
    const other = await loginAs(app, u.email, u.password);
    const res = await u.api.post('/api/auth/password', { currentPassword: 'not-my-password', newPassword: 'brand-new-password-1' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await other.get('/api/auth/me')).status).toBe(200);
    expect((await new Api(app).post('/api/auth/login', { email: u.email, password: u.password })).status).toBe(200);
  });

  it('новый пароль проверяется по тем же правилам; без входа и с API-ключом смена невозможна', async () => {
    const u = await newUser(app);
    const weak = await u.api.post('/api/auth/password', { currentPassword: u.password, newPassword: 'short' });
    expect(weak.status).toBe(400);

    expect((await new Api(app).post('/api/auth/password', { currentPassword: 'a', newPassword: 'b'.repeat(10) })).status).toBe(401);

    const key = await u.api.post('/api/api-keys', { name: 'ci' });
    const viaKey = new Api(app);
    viaKey.bearer = key.body.key;
    const res = await viaKey.post('/api/auth/password', { currentPassword: u.password, newPassword: 'brand-new-password-1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SESSION_REQUIRED');
  });

  it('подбор текущего пароля ограничен по частоте', async () => {
    const u = await newUser(app);
    for (let i = 0; i < 5; i++) expect((await u.api.post('/api/auth/password', { currentPassword: `wrong-${i}-password`, newPassword: 'brand-new-password-1' })).status).toBe(401);
    expect((await u.api.post('/api/auth/password', { currentPassword: u.password, newPassword: 'brand-new-password-1' })).status).toBe(429);
  });
});

describe('блокировка пользователя', () => {
  let admin: Api;
  beforeAll(async () => {
    admin = await loginAs(app, ADMIN.email, ADMIN.password);
  });

  it('заблокированный сразу теряет доступ: сессия, вход и API-ключ; после разблокировки всё возвращается', async () => {
    const u = await newUser(app, { balance: 100 });
    const phone = await loginAs(app, u.email, u.password);
    const key = await u.api.post('/api/api-keys', { name: 'ci' });
    const viaKey = new Api(app);
    viaKey.bearer = key.body.key;
    expect((await viaKey.get('/api/auth/me')).status).toBe(200);

    const blocked = await admin.post(`/api/admin/users/${u.id}/block`);
    expect(blocked.status).toBe(200);

    for (const api of [u.api, phone]) {
      const me = await api.get('/api/auth/me');
      expect(me.status).toBe(403);
      expect(me.body.error.code).toBe('USER_BLOCKED');
      expect((await api.get('/api/instances')).status).toBe(403);
      expect((await api.post('/api/payments', { amount: 100 })).status).toBe(403);
    }
    const keyRes = await viaKey.get('/api/instances');
    expect(keyRes.status).toBe(403);
    expect(keyRes.body.error.code).toBe('USER_BLOCKED');

    const login = await new Api(app).post('/api/auth/login', { email: u.email, password: u.password });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('USER_BLOCKED');
    expect(login.headers['set-cookie']).toBeUndefined();

    const audit = await sql<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.status_changed' AND entity_id = $1", [String(u.id)]);
    expect(audit[0]!.n).toBeGreaterThanOrEqual(1);

    expect((await admin.post(`/api/admin/users/${u.id}/unblock`)).status).toBe(200);
    expect((await u.api.get('/api/auth/me')).status).toBe(200);
    expect((await viaKey.get('/api/auth/me')).status).toBe(200);
    expect((await new Api(app).post('/api/auth/login', { email: u.email, password: u.password })).status).toBe(200);
  });

  it('заблокированный с запущенным инстансом не может запускать новые', async () => {
    const u = await newUser(app, { balance: 1000 });
    await admin.post(`/api/admin/users/${u.id}/block`);
    const res = await u.api.post('/api/instances', { name: 'x', datacenterCode: 'MSK-1', gpuModel: 'RTX 4090', gpuCount: 1, pricingType: 'on_demand', templateId: 1 });
    expect(res.status).toBe(403);
    await admin.post(`/api/admin/users/${u.id}/unblock`);
  });

  it('администратор не может заблокировать себя; несуществующий пользователь — 404', async () => {
    const me = await admin.get('/api/auth/me');
    const self = await admin.post(`/api/admin/users/${me.body.user.id}/block`);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('INVALID_STATE');
    expect((await admin.post('/api/admin/users/999999/block')).status).toBe(404);
  });
});

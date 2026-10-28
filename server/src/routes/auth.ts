import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Config } from '../config';
import { query, withUser } from '../db';
import { badRequest, conflict, forbidden, sqlState, tooManyRequests, unauthorized } from '../errors';
import { NO_STORE, requireSession, userCtx, wrap } from '../http';
import type { AuthUser } from '../http';
import { authenticate, clearSessionCookie, requireUser, setSessionCookie } from '../auth/middleware';
import { hashPassword, verifyPassword } from '../auth/password';
import { newToken, sha256 } from '../auth/tokens';
import { changePasswordBody, loginBody, parse, registerBody, verifyBody } from '../schemas';

export const userDto = (u: AuthUser) => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  role: u.role,
  status: u.status,
  balance: u.balance,
  emailVerified: u.emailVerified,
});

const EMAIL_TOKEN_TTL_SECONDS = 24 * 3600;

/**
 * Попытка входа/регистрации учитывается в БД (fn_auth_throttle_hit), а не в памяти процесса:
 * на serverless каждый запрос может попасть в новый экземпляр функции со своим пустым счётчиком.
 */
async function throttle(scope: string, key: string, limit: { max: number; windowSeconds: number }): Promise<void> {
  const r = await query<{ retry: number }>('SELECT fn_auth_throttle_hit($1, $2, $3, $4) AS retry', [scope, key, limit.max, limit.windowSeconds]);
  const retry = r.rows[0]?.retry ?? 0;
  if (retry > 0) throw tooManyRequests(retry);
}

function verifyUrl(config: Config, req: Request, token: string): string {
  const base = config.appUrl ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`;
  return `${base}/verify?token=${token}`;
}

export function authRoutes(config: Config): Router {
  const router = Router();
  const auth = authenticate(config);

  // Все ответы здесь персональные (пользователь, ссылка подтверждения, cookie): CDN их хранить не должен
  router.use((_req, res, next) => {
    res.set('Cache-Control', NO_STORE);
    next();
  });

  async function startSession(req: Request, res: Response, userId: number): Promise<void> {
    const token = newToken();
    const r = await query<{ expires: Date }>('SELECT fn_session_create($1, $2, $3, $4, $5) AS expires', [
      userId,
      sha256(token),
      config.sessionTtlSeconds,
      req.ip ?? null,
      req.headers['user-agent'] ?? null,
    ]);
    setSessionCookie(res, config, token, r.rows[0]!.expires);
  }

  // POST /api/auth/register
  router.post(
    '/register',
    wrap(async (req, res) => {
      const body = parse(registerBody, req.body);
      await throttle('register_ip', req.ip ?? 'unknown', config.limits.registerIp);
      const hash = await hashPassword(body.password, config.bcryptCost);
      const token = newToken();
      let id: number;
      try {
        const r = await query<{ id: number }>('SELECT fn_web_register($1, $2, $3, $4, $5) AS id', [
          body.email,
          hash,
          body.fullName,
          sha256(token),
          EMAIL_TOKEN_TTL_SECONDS,
        ]);
        id = r.rows[0]!.id;
      } catch (e) {
        if (sqlState(e) === '23505') throw conflict('Пользователь с таким email уже зарегистрирован', 'EMAIL_TAKEN');
        throw e;
      }
      const user: AuthUser = { id, email: body.email, fullName: body.fullName, role: 'client', status: 'active', balance: '0.0000', emailVerified: false };
      req.log.info({ userId: id }, 'user registered');
      // Почтового провайдера нет: в демо-режиме ссылка подтверждения возвращается прямо в ответе.
      res.status(201).json({ user: userDto(user), ...(config.demoMail ? { verifyUrl: verifyUrl(config, req, token) } : {}) });
    }),
  );

  // POST /api/auth/login
  router.post(
    '/login',
    wrap(async (req, res) => {
      const body = parse(loginBody, req.body);
      // Жёсткий лимит — на пару «email + адрес»: иначе любой, знающий чужой email, мог бы запереть его владельца
      // десятью неверными попытками. Общий лимит на email высокий и защищает только от подбора с множества адресов.
      const ip = req.ip ?? 'unknown';
      await throttle('login_ip', ip, config.limits.loginIp);
      await throttle('login_email_ip', `${body.email}|${ip}`, config.limits.loginEmailIp);
      await throttle('login_email', body.email, config.limits.loginEmail);
      const r = await query<{ o_id: number; o_password_hash: string; o_status: 'active' | 'blocked' }>(
        'SELECT * FROM fn_web_user_by_email($1)',
        [body.email],
      );
      const row = r.rows[0];
      const ok = await verifyPassword(body.password, row?.o_password_hash);
      if (!row || !ok) throw unauthorized('Неверный email или пароль', 'INVALID_CREDENTIALS');
      if (row.o_status !== 'active') throw forbidden('Учётная запись заблокирована', 'USER_BLOCKED');
      await query('SELECT fn_auth_throttle_clear($1, $2)', ['login_email_ip', `${body.email}|${ip}`]);
      await startSession(req, res, row.o_id);
      res.set('Cache-Control', NO_STORE);
      res.json({ user: await loadUser(row.o_id) });
    }),
  );

  async function loadUser(userId: number): Promise<ReturnType<typeof userDto>> {
    const r = await withUser({ userId, role: 'client' }, (c) =>
      c.query<{ id: number; email: string; full_name: string; role: 'client' | 'admin'; status: 'active' | 'blocked'; balance: string; email_verified_at: Date | null }>(
        'SELECT id, email, full_name, role, status, balance, email_verified_at FROM users WHERE id = $1',
        [userId],
      ),
    );
    const u = r.rows[0]!;
    return userDto({ id: u.id, email: u.email, fullName: u.full_name, role: u.role, status: u.status, balance: u.balance, emailVerified: u.email_verified_at !== null });
  }

  // POST /api/auth/logout
  router.post(
    '/logout',
    auth,
    wrap(async (req, res) => {
      if (req.sessionHash) await query('SELECT fn_session_delete($1)', [req.sessionHash]);
      clearSessionCookie(res, config);
      res.json({ ok: true });
    }),
  );

  // GET /api/auth/me
  router.get(
    '/me',
    auth,
    requireUser,
    wrap(async (req, res) => {
      res.json({ user: userDto(req.user!) });
    }),
  );

  // POST /api/auth/password
  router.post(
    '/password',
    auth,
    requireUser,
    requireSession,
    wrap(async (req, res) => {
      const body = parse(changePasswordBody, req.body);
      const user = req.user!;
      await throttle('password', String(user.id), config.limits.password);
      const current = await withUser(userCtx(req), (c) => c.query<{ h: string }>('SELECT fn_web_password_hash() AS h'));
      if (!(await verifyPassword(body.currentPassword, current.rows[0]?.h))) {
        throw unauthorized('Текущий пароль указан неверно', 'INVALID_CREDENTIALS');
      }
      const hash = await hashPassword(body.newPassword, config.bcryptCost);
      const token = newToken();
      // Все прежние сессии пользователя удаляются, текущему браузеру выдаётся новая: старый токен мог быть украден.
      // API-ключи тоже отзываются (это делает fn_web_set_password): ключ, выпущенный из украденной сессии,
      // иначе пережил бы смену пароля. Число считаем в той же транзакции, чтобы показать его пользователю.
      const r = await withUser(userCtx(req), async (c) => {
        const keys = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())',
          [user.id],
        );
        const changed = await c.query<{ expires: Date }>('SELECT fn_web_set_password($1, $2, $3, $4, $5) AS expires', [
          hash,
          sha256(token),
          config.sessionTtlSeconds,
          req.ip ?? null,
          req.headers['user-agent'] ?? null,
        ]);
        return { expires: changed.rows[0]!.expires, apiKeysRevoked: keys.rows[0]!.n };
      });
      setSessionCookie(res, config, token, r.expires);
      req.log.info({ apiKeysRevoked: r.apiKeysRevoked }, 'password changed, other sessions and api keys dropped');
      res.json({ user: userDto(user), apiKeysRevoked: r.apiKeysRevoked });
    }),
  );

  // POST /api/auth/verify — публичный: ссылка из письма открывается и без входа
  router.post(
    '/verify',
    wrap(async (req, res) => {
      const body = parse(verifyBody, req.body);
      const r = await query<{ id: number | null }>('SELECT fn_web_verify_email($1) AS id', [sha256(body.token)]);
      if (r.rows[0]?.id == null) throw badRequest('Ссылка подтверждения недействительна или устарела', 'INVALID_TOKEN');
      res.json({ verified: true });
    }),
  );

  // POST /api/auth/resend
  router.post(
    '/resend',
    auth,
    requireUser,
    wrap(async (req, res) => {
      await throttle('resend', String(req.user!.id), config.limits.resend);
      const token = newToken();
      await withUser(userCtx(req), (c) => c.query('SELECT fn_web_email_token_create($1, $2)', [sha256(token), EMAIL_TOKEN_TTL_SECONDS]));
      res.json({ sent: true, ...(config.demoMail ? { verifyUrl: verifyUrl(config, req, token) } : {}) });
    }),
  );

  return router;
}

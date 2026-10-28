import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config';
import { query } from '../db';
import { AppError, forbidden, unauthorized } from '../errors';
import type { AuthUser } from '../http';
import { isApiKeyFormat, sha256 } from './tokens';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined; // кривое %-кодирование: такой cookie всё равно не наша, это не повод отвечать 500
      }
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, config: Config, token: string, expiresAt: Date): void {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response, config: Config): void {
  res.clearCookie(config.cookieName, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });
}

interface UserRow {
  o_user_id: number;
  o_email: string;
  o_full_name: string;
  o_role: 'client' | 'admin';
  o_status: 'active' | 'blocked';
  o_balance: string;
  o_email_verified_at: Date | null;
}

export function toAuthUser(r: UserRow): AuthUser {
  return {
    id: r.o_user_id,
    email: r.o_email,
    fullName: r.o_full_name,
    role: r.o_role,
    status: r.o_status,
    balance: r.o_balance,
    emailVerified: r.o_email_verified_at !== null,
  };
}

/**
 * Определяет пользователя: заголовок Authorization: Bearer gr_... либо cookie сессии. Если передан Bearer,
 * cookie игнорируется целиком — иначе неверный ключ мог бы «подхватить» чужую сессию.
 * Без учётных данных запрос идёт дальше анонимным; требовать вход должны requireUser и другие.
 * Подключается только на маршрутах с персональными данными: публичный каталог его не вызывает и cookie не трогает.
 */
export function authenticate(config: Config) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authorization = req.headers.authorization;
      if (authorization !== undefined) {
        const m = /^Bearer (\S+)$/.exec(authorization);
        const key = m?.[1];
        if (!key || !isApiKeyFormat(key)) throw unauthorized('Неверный API-ключ', 'INVALID_API_KEY');
        const r = await query<UserRow>('SELECT * FROM fn_find_api_key($1)', [sha256(key)]);
        const row = r.rows[0];
        if (!row) throw unauthorized('Неверный или отозванный API-ключ', 'INVALID_API_KEY');
        req.user = toAuthUser(row);
        req.authVia = 'apikey';
      } else {
        const token = readCookie(req, config.cookieName);
        if (token) {
          const hash = sha256(token);
          const r = await query<UserRow & { o_renewed: boolean; o_expires_at: Date }>(
            'SELECT * FROM fn_session_resolve($1, $2, 600)',
            [hash, config.sessionTtlSeconds],
          );
          const row = r.rows[0];
          if (row) {
            req.user = toAuthUser(row);
            req.authVia = 'cookie';
            req.sessionHash = hash;
            if (row.o_renewed) setSessionCookie(res, config, token, row.o_expires_at); // скользящее продление и у браузера
          } else {
            clearSessionCookie(res, config); // сессия просрочена или удалена
          }
        }
      }
      if (req.user) req.log = req.log.child({ userId: req.user.id });
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.user.status === 'blocked') return next(forbidden('Учётная запись заблокирована', 'USER_BLOCKED'));
  next();
}

/**
 * Защита от CSRF для запросов, которые меняют данные. Действует на всё, что не подписано иначе:
 * cookie-сессии, вход и регистрация (login-CSRF). Исключены вызовы с Bearer-ключом (браузер сам такой
 * заголовок в чужой форме не поставит), подписанные вебхуки и cron (свой секрет).
 * Нужны оба условия: заголовок X-Requested-With: fetch (его нельзя выставить кросс-доменной формой)
 * и Origin своего сайта; вместе с SameSite=Lax это закрывает подделку запроса.
 */
export function csrfGuard(config: Config) {
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE.has(req.method)) return next();
    if (req.headers.authorization?.startsWith('Bearer ')) return next();
    if (req.path.startsWith('/api/webhooks/') || req.path.startsWith('/api/internal/')) return next();

    if (req.headers['x-requested-with'] !== 'fetch') {
      return next(new AppError(403, 'CSRF', 'Нужен заголовок X-Requested-With: fetch'));
    }
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !isSameSite(origin, req, config)) {
      return next(new AppError(403, 'CSRF', 'Запрос с чужого или неопределённого источника (Origin)'));
    }
    next();
  };
}

function isSameSite(origin: string, req: Request, config: Config): boolean {
  const normalized = origin.replace(/\/+$/, '');
  if (config.allowedOrigins.includes(normalized)) return true;
  if (config.appUrl && normalized === config.appUrl) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

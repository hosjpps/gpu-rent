import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import type { DbContext } from './db';
import { AppError, unauthorized } from './errors';

export interface AuthUser {
  id: number;
  email: string;
  fullName: string;
  role: 'client' | 'admin';
  status: 'active' | 'blocked';
  balance: string;
  emailVerified: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    log: Logger;
    user?: AuthUser;
    /** Чем подтверждена личность: cookie сессии или API-ключом. */
    authVia?: 'cookie' | 'apikey';
    sessionHash?: Buffer;
  }
}

/** Express 4 не ловит отклонённые промисы сам: оборачиваем асинхронные обработчики. */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Контекст БД для запроса вошедшего пользователя. */
export function userCtx(req: Request): DbContext {
  if (!req.user) throw unauthorized();
  return { userId: req.user.id, role: req.user.role, ip: req.ip };
}

export const anonCtx = (req: Request): DbContext => ({ role: 'anon', ip: req.ip });
export const systemCtx = (req: Request): DbContext => ({ role: 'system', ip: req.ip });

export const PUBLIC_CACHE = 'public, s-maxage=30, stale-while-revalidate=60';
export const NO_STORE = 'private, no-store';

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(new AppError(403, 'FORBIDDEN', 'Доступно только администратору'));
  next();
}

/** Только вход по cookie сессии: управление ключами и паролем API-ключом недоступно. */
export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthorized());
  if (req.authVia !== 'cookie') return next(new AppError(403, 'SESSION_REQUIRED', 'Действие доступно только из браузера, по сессии, а не по API-ключу'));
  next();
}

/** ISO-строка либо null. */
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

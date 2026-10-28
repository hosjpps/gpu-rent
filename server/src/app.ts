import { randomUUID } from 'node:crypto';
import express from 'express';
import type { ErrorRequestHandler, Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { csrfGuard } from './auth/middleware';
import { loadConfig } from './config';
import type { Config } from './config';
import { configureDb } from './db';
import { notFound, toAppError } from './errors';
import { NO_STORE } from './http';
import { createLogger } from './logger';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { billingRoutes } from './routes/billing';
import { docsRoutes } from './routes/docs';
import { instanceRoutes } from './routes/instances';
import { keyRoutes } from './routes/keys';
import { paymentRoutes } from './routes/payments';
import { systemRoutes } from './routes/system';
import { volumeRoutes } from './routes/volumes';

/**
 * Собирает приложение. Импорт модуля ничего не запускает: окружение читается и пул БД создаётся
 * только здесь и при первом запросе. Так одно и то же приложение работает и как процесс (index.ts),
 * и как serverless-функция Vercel (api/index.ts), и в тестах.
 */
export function createApp(env: NodeJS.ProcessEnv = process.env, prebuilt?: Config): Express {
  const config = prebuilt ?? loadConfig(env);
  configureDb(config);
  const logger = createLogger(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req: Request, res: Response, next: NextFunction) => {
    req.id = (req.headers['x-vercel-id'] as string | undefined) ?? randomUUID();
    req.log = logger.child({ reqId: req.id });
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      req.log.info({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }, 'request');
    });
    next();
  });

  app.use(
    helmet({
      // API отдаёт только JSON; единственная HTML-страница (/api/docs) задаёт свою политику сама.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      strictTransportSecurity: config.isProd ? { maxAge: 63072000, includeSubDomains: true } : false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );

  // Вебхук проверяет подпись по сырому телу, поэтому его тело не разбирается как JSON.
  app.use('/api/webhooks/payments', express.raw({ type: '*/*', limit: '32kb' }));
  app.use(express.json({ limit: '32kb' }));
  app.use(csrfGuard(config));

  app.use('/api/auth', authRoutes(config));
  app.use('/api', systemRoutes(config));
  app.use('/api', docsRoutes(config));
  app.use('/api', keyRoutes(config));
  app.use('/api', instanceRoutes(config));
  app.use('/api', volumeRoutes(config));
  app.use('/api', billingRoutes(config));
  app.use('/api', paymentRoutes(config));
  app.use('/api/admin', adminRoutes(config));

  app.use('/api', (_req, _res, next) => next(notFound('Такого адреса в API нет', 'ROUTE_NOT_FOUND')));

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    const e = toAppError(err);
    if (e.status >= 500) req.log.error({ err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, 'ошибка запроса');
    for (const [k, v] of Object.entries(e.headers ?? {})) res.setHeader(k, v);
    res.setHeader('Cache-Control', NO_STORE);
    res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } });
  };
  app.use(onError);
  return app;
}

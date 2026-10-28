import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Config } from '../config';
import { withUser } from '../db';
import { AppError, notFound, unauthorized } from '../errors';
import { NO_STORE, PUBLIC_CACHE, anonCtx, iso, systemCtx, wrap } from '../http';

interface GpuRow {
  datacenter_code: string;
  datacenter_name: string;
  city: string;
  gpu_model: string;
  vram_gb: number;
  total_gpus: number;
  free_gpus: number;
  price_on_demand: string | null;
  price_spot: string | null;
}

interface TemplateRow {
  id: number;
  name: string;
  docker_image: string;
  default_disk_gb: number;
  default_ports: string;
}

interface BillingRow {
  o_users: number;
  o_usage_rows: number;
  o_amount: string;
  o_stopped: number;
}

interface CleanupRow {
  o_sessions: number;
  o_attempts: number;
  o_tokens: number;
  o_runs: number;
}

/** Сравнение секрета за постоянное время: хэши одинаковой длины, длина секрета не утекает. */
function secretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function systemRoutes(config: Config): Router {
  const router = Router();

  // GET /api/health — без обращения к БД: быстрый ответ для внешнего мониторинга и не будит Neon.
  // GET /api/health?deep=1 — ещё SELECT 1 и время последнего прохода биллинга; звать редко (раз в час).
  router.get(
    '/health',
    wrap(async (req, res) => {
      res.set('Cache-Control', NO_STORE);
      const base = { version: config.version, time: new Date().toISOString() };
      if (req.query.deep !== '1') {
        res.json({ status: 'ok', ...base });
        return;
      }
      try {
        const lastBillingAt = await withUser(anonCtx(req), async (c) => {
          await c.query('SELECT 1');
          const r = await c.query<{ at: Date | null }>('SELECT fn_last_billing_at() AS at');
          return iso(r.rows[0]?.at);
        });
        res.json({ status: 'ok', db: 'ok', ...base, lastBillingAt });
      } catch (e) {
        req.log.error({ err: e instanceof Error ? e.message : String(e) }, 'health: БД недоступна');
        res.status(503).json({ status: 'error', db: 'down', ...base, lastBillingAt: null });
      }
    }),
  );

  // GET /api/catalog/gpus — публичный: без authenticate, поэтому cookie не читается и ответ одинаков для всех.
  router.get(
    '/catalog/gpus',
    wrap(async (req, res) => {
      const r = await withUser(anonCtx(req), (c) =>
        c.query<GpuRow>(
          `SELECT v.datacenter_code, d.name AS datacenter_name, d.city, v.gpu_model, v.vram_gb,
                  v.total_gpus, v.free_gpus, v.price_on_demand, v.price_spot
           FROM v_gpu_availability v
           JOIN datacenters d ON d.id = v.datacenter_id
           ORDER BY v.datacenter_code, v.gpu_model`,
        ),
      );
      res.set('Cache-Control', PUBLIC_CACHE);
      res.json(
        r.rows.map((g) => ({
          datacenter: { code: g.datacenter_code, name: g.datacenter_name, city: g.city },
          model: { name: g.gpu_model, vramGb: g.vram_gb },
          total: g.total_gpus,
          free: g.free_gpus,
          priceOnDemand: g.price_on_demand,
          priceSpot: g.price_spot,
        })),
      );
    }),
  );

  // GET /api/catalog/templates — только публичные шаблоны, иначе общий кэш CDN отдал бы чужие приватные.
  // Свои приватные — GET /api/templates/mine (routes/keys.ts, без кэша).
  router.get(
    '/catalog/templates',
    wrap(async (req, res) => {
      const r = await withUser(anonCtx(req), (c) =>
        c.query<TemplateRow>(
          'SELECT id, name, docker_image, default_disk_gb, default_ports FROM templates WHERE is_public ORDER BY id',
        ),
      );
      res.set('Cache-Control', PUBLIC_CACHE);
      res.json(
        r.rows.map((t) => ({
          id: t.id,
          name: t.name,
          dockerImage: t.docker_image,
          defaultDiskGb: t.default_disk_gb,
          defaultPorts: t.default_ports,
          isPublic: true,
        })),
      );
    }),
  );

  // GET и POST /api/internal/billing — полный проход биллинга. GET нужен Vercel Cron (он шлёт только GET),
  // POST — GitHub Actions. Доступ по секрету, а не по сессии, поэтому csrfGuard эти адреса пропускает.
  async function billingPass(req: Request, res: Response): Promise<void> {
    res.set('Cache-Control', NO_STORE);
    if (!config.cronSecret) {
      // В проде отсутствие секрета — ошибка настройки (её должно быть видно), локально эндпоинт просто выключен.
      throw config.isProd ? new AppError(503, 'CRON_NOT_CONFIGURED', 'Биллинг по расписанию не настроен') : notFound('Такого адреса в API нет', 'ROUTE_NOT_FOUND');
    }
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    if (!m?.[1] || !secretMatches(m[1], config.cronSecret)) {
      res.set('WWW-Authenticate', 'Bearer');
      throw unauthorized('Неверный секрет планировщика', 'INVALID_CRON_SECRET');
    }

    // Начисление — отдельная транзакция: блокировки пользователей отпускаются сразу, а сбой обслуживания
    // ниже не откатывает уже начисленное. Потолок времени запроса роли (15 с) для полного прохода мал,
    // а функция Vercel живёт до 60 с (vercel.json).
    const billed = await withUser(systemCtx(req), async (c) => {
      await c.query("SET LOCAL statement_timeout = '50s'");
      const r = await c.query<BillingRow>('SELECT * FROM fn_bill_usage()');
      return r.rows[0]!;
    });

    const cleaned = await withUser(systemCtx(req), async (c) => {
      await c.query("SET LOCAL statement_timeout = '50s'");
      await c.query('SELECT fn_ensure_usage_partition()'); // партиция на следующий месяц, заранее
      await c.query('SELECT fn_refresh_daily_revenue()');
      const r = await c.query<CleanupRow>('SELECT * FROM fn_web_cleanup()');
      const row = r.rows[0]!;
      const result = { users: billed.o_users, records: billed.o_usage_rows, charged: billed.o_amount, stopped: billed.o_stopped };
      await c.query('SELECT fn_billing_run_done($1::jsonb)', [JSON.stringify(result)]);
      return { sessions: row.o_sessions, attempts: row.o_attempts, tokens: row.o_tokens, runs: row.o_runs };
    });

    req.log.info({ users: billed.o_users, records: billed.o_usage_rows, charged: billed.o_amount, stopped: billed.o_stopped }, 'billing pass');
    res.json({ users: billed.o_users, records: billed.o_usage_rows, charged: billed.o_amount, stopped: billed.o_stopped, cleaned });
  }

  router.get('/internal/billing', wrap(billingPass));
  router.post('/internal/billing', wrap(billingPass));

  return router;
}

import { Router } from 'express';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from '../config';
import { withUser } from '../db';
import { badRequest, conflict, notFound, sqlState } from '../errors';
import { NO_STORE, iso, requireAdmin, requireSession, userCtx, wrap } from '../http';
import { authenticate, requireUser } from '../auth/middleware';
import { decodeCursor, encodeCursor } from '../cursor';
import { idParams, limitSchema, nodeStatusBody, parse, setPriceBody } from '../schemas';

// ---- входные данные, которых нет в schemas.ts ----

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
const dashboardQuery = z.object({ from: day.optional(), to: day.optional() });
const usersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const auditQuery = z.object({ cursor: z.string().max(200).optional(), limit: limitSchema });
const auditCursor = z.object({ id: z.number().int().positive() });

const DAY_MS = 24 * 3600 * 1000;
const MAX_PERIOD_DAYS = 366;

/** Сегодняшняя дата по Москве: витрина mv_daily_revenue группирует выручку по московским суткам. */
function todayMoscow(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 2026-02-31 по формату проходит, но такой даты нет: туда-обратно строка меняется. */
const isRealDate = (s: string): boolean => {
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

// ---- запросы, которые используются в нескольких местах ----

const GPU_PRICE_SQL = `
  SELECT p.id, d.code AS dc_code, d.name AS dc_name, m.name AS model, p.pricing_type, p.price_per_hour,
         lower(p.valid_during) AS valid_from, upper(p.valid_during) AS valid_to
  FROM gpu_prices p
  JOIN datacenters d ON d.id = p.datacenter_id
  JOIN gpu_models m ON m.id = p.gpu_model_id`;

interface GpuPriceRow {
  id: number;
  dc_code: string;
  dc_name: string;
  model: string;
  pricing_type: 'on_demand' | 'spot';
  price_per_hour: string;
  valid_from: Date;
  valid_to: Date | null;
}

const priceDto = (r: GpuPriceRow) => ({
  id: r.id,
  datacenter: { code: r.dc_code, name: r.dc_name },
  gpuModel: r.model,
  pricingType: r.pricing_type,
  pricePerHour: r.price_per_hour,
  validFrom: r.valid_from.toISOString(),
  validTo: iso(r.valid_to),
});

interface UserRow {
  id: number;
  email: string;
  full_name: string;
  role: 'client' | 'admin';
  status: 'active' | 'blocked';
  balance: string;
  email_verified_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = 'id, email, full_name, role, status, balance, email_verified_at, created_at';

const userDto = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  fullName: u.full_name,
  role: u.role,
  status: u.status,
  balance: u.balance,
  emailVerified: u.email_verified_at !== null,
  createdAt: u.created_at.toISOString(),
});

/** Запись в журнал для действий, на которые в БД нет триггера аудита (цены и пользователей он ведёт сам). */
async function writeAudit(c: PoolClient, action: string, entity: string, entityId: number, details: Record<string, unknown>): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip)
     VALUES (fn_app_user_id(), $1, $2, $3, $4::jsonb, nullif(current_setting('app.client_ip', true), '')::inet)`,
    [action, entity, String(entityId), JSON.stringify(details)],
  );
}

export function adminRoutes(config: Config): Router {
  const router = Router();

  // Всё под /api/admin: только вошедший, не заблокированный администратор; ответы персональные.
  router.use((_req, res, next) => {
    res.set('Cache-Control', NO_STORE);
    next();
  });
  router.use(authenticate(config), requireUser, requireAdmin);

  // ---------------------------------------------------------------- дашборд

  // GET /api/admin/dashboard?from=&to= — по умолчанию последние 30 суток (по Москве)
  router.get(
    '/dashboard',
    wrap(async (req, res) => {
      const q = parse(dashboardQuery, req.query);
      const to = q.to ?? todayMoscow();
      const from = q.from ?? shiftDays(to, -29);
      if (!isRealDate(from) || !isRealDate(to)) throw badRequest('Такой даты нет в календаре', 'INVALID_PERIOD');
      if (from > to) throw badRequest('Начало периода позже конца', 'INVALID_PERIOD');
      if ((Date.parse(to) - Date.parse(from)) / DAY_MS >= MAX_PERIOD_DAYS) {
        throw badRequest(`Период не должен быть длиннее ${MAX_PERIOD_DAYS} суток`, 'INVALID_PERIOD');
      }

      const data = await withUser(userCtx(req), async (c) => {
        // дни без выручки тоже попадают в ряд (нулями), чтобы график шёл без пропусков
        const byDay = await c.query<{ day: string; revenue: string; gpu_hours: string }>(
          `SELECT d::date::text AS day,
                  round(coalesce(sum(r.revenue), 0), 4)   AS revenue,
                  round(coalesce(sum(r.gpu_hours), 0), 4) AS gpu_hours
           FROM generate_series($1::timestamp, $2::timestamp, interval '1 day') d
           LEFT JOIN mv_daily_revenue r ON r.day = d::date
           GROUP BY d ORDER BY d`,
          [from, to],
        );
        const byDc = await c.query<{ code: string; name: string; revenue: string }>(
          `SELECT dc.code, dc.name, round(coalesce(sum(r.revenue), 0), 4) AS revenue
           FROM datacenters dc
           LEFT JOIN mv_daily_revenue r ON r.datacenter_id = dc.id AND r.day BETWEEN $1::date AND $2::date
           GROUP BY dc.id ORDER BY sum(r.revenue) DESC NULLS LAST, dc.code`,
          [from, to],
        );
        const byModel = await c.query<{ name: string; revenue: string }>(
          `SELECT m.name, round(coalesce(sum(r.revenue), 0), 4) AS revenue
           FROM gpu_models m
           LEFT JOIN mv_daily_revenue r ON r.gpu_model_id = m.id AND r.day BETWEEN $1::date AND $2::date
           GROUP BY m.id ORDER BY sum(r.revenue) DESC NULLS LAST, m.name`,
          [from, to],
        );
        const sum = await c.query<{ revenue: string; gpu_hours: string }>(
          `SELECT round(coalesce(sum(revenue), 0), 4) AS revenue, round(coalesce(sum(gpu_hours), 0), 4) AS gpu_hours
           FROM mv_daily_revenue WHERE day BETWEEN $1::date AND $2::date`,
          [from, to],
        );
        // загрузка берётся из того же представления, что и каталог, поэтому «свободно» совпадает с каталогом
        const loadByDc = await c.query<UtilRow>(
          `SELECT d.code AS key, d.name AS name, sum(v.total_gpus)::int AS total, sum(v.busy_gpus)::int AS busy,
                  sum(v.free_gpus)::int AS free, sum(v.total_gpus - v.enabled_gpus)::int AS disabled
           FROM v_gpu_availability v JOIN datacenters d ON d.id = v.datacenter_id
           GROUP BY d.id ORDER BY d.code`,
        );
        const loadByModel = await c.query<UtilRow>(
          `SELECT v.gpu_model AS key, v.gpu_model AS name, sum(v.total_gpus)::int AS total, sum(v.busy_gpus)::int AS busy,
                  sum(v.free_gpus)::int AS free, sum(v.total_gpus - v.enabled_gpus)::int AS disabled
           FROM v_gpu_availability v GROUP BY v.gpu_model ORDER BY v.gpu_model`,
        );
        const billing = await c.query<{ at: Date | null }>('SELECT fn_last_billing_at() AS at');
        return { byDay, byDc, byModel, sum: sum.rows[0]!, loadByDc, loadByModel, lastBillingAt: billing.rows[0]?.at ?? null };
      });

      const total = (rows: UtilRow[], f: 'total' | 'busy' | 'free' | 'disabled') => rows.reduce((s, r) => s + r[f], 0);
      res.json({
        // поля, которые читает фронтенд
        revenueByDay: data.byDay.rows.map((r) => ({ day: r.day, revenue: r.revenue, gpuHours: r.gpu_hours })),
        revenueByDatacenter: data.byDc.rows,
        revenueByModel: data.byModel.rows,
        utilization: {
          total: total(data.loadByDc.rows, 'total'),
          busy: total(data.loadByDc.rows, 'busy'),
          free: total(data.loadByDc.rows, 'free'),
          disabled: total(data.loadByDc.rows, 'disabled'),
        },
        // дополнительно: загрузка в разрезе ДЦ и моделей, сводка за период, актуальность витрины
        utilizationByDatacenter: data.loadByDc.rows.map(({ key, ...r }) => ({ code: key, ...r })),
        utilizationByModel: data.loadByModel.rows.map(({ key: _key, ...r }) => r),
        period: { from, to, revenue: data.sum.revenue, gpuHours: data.sum.gpu_hours },
        lastBillingAt: iso(data.lastBillingAt),
      });
    }),
  );

  // ---------------------------------------------------------------- цены

  // GET /api/admin/prices — история цен GPU (все периоды, действующие и закрытые)
  router.get(
    '/prices',
    wrap(async (req, res) => {
      const r = await withUser(userCtx(req), (c) =>
        c.query<GpuPriceRow>(`${GPU_PRICE_SQL} ORDER BY d.code, m.name, p.pricing_type, lower(p.valid_during) DESC`),
      );
      res.json(r.rows.map(priceDto));
    }),
  );

  // GET /api/admin/prices/storage — история цен хранения (₽ за ГБ в месяц)
  router.get(
    '/prices/storage',
    wrap(async (req, res) => {
      const r = await withUser(userCtx(req), (c) =>
        c.query<{ id: number; dc_code: string; dc_name: string; price: string; valid_from: Date; valid_to: Date | null }>(
          `SELECT p.id, d.code AS dc_code, d.name AS dc_name, p.price_per_gb_month AS price,
                  lower(p.valid_during) AS valid_from, upper(p.valid_during) AS valid_to
           FROM storage_prices p JOIN datacenters d ON d.id = p.datacenter_id
           ORDER BY d.code, lower(p.valid_during) DESC`,
        ),
      );
      res.json(
        r.rows.map((p) => ({
          id: p.id,
          datacenter: { code: p.dc_code, name: p.dc_name },
          pricePerGbMonth: p.price,
          validFrom: p.valid_from.toISOString(),
          validTo: iso(p.valid_to),
        })),
      );
    }),
  );

  // POST /api/admin/prices — новая цена закрывает действующую в той же транзакции
  router.post(
    '/prices',
    requireSession,
    wrap(async (req, res) => {
      const body = parse(setPriceBody, req.body);
      const result = await withUser(userCtx(req), async (c) => {
        const keys = await c.query<{ dc: number; model: number }>(
          'SELECT d.id AS dc, m.id AS model FROM datacenters d, gpu_models m WHERE d.code = $1 AND m.name = $2',
          [body.datacenterCode, body.gpuModel],
        );
        const key = keys.rows[0];
        if (!key) throw notFound('Дата-центр или модель GPU не найдены', 'NOT_FOUND');

        // FOR UPDATE: два администратора одновременно не закроют один и тот же период
        const current = await c.query<{ id: number; same: boolean }>(
          `SELECT id, price_per_hour = $4::numeric AS same FROM gpu_prices
           WHERE datacenter_id = $1 AND gpu_model_id = $2 AND pricing_type = $3 AND valid_during @> now()
           FOR UPDATE`,
          [key.dc, key.model, body.pricingType, body.pricePerHour],
        );
        const cur = current.rows[0];
        let id: number;
        let changed = false;
        if (cur?.same) {
          // та же цена повторно: ничего не меняем, чтобы не дробить историю и не засорять журнал
          id = cur.id;
        } else {
          // период закрывается моментом now() транзакции, новый открывается с него же: ни пересечения, ни разрыва
          if (cur) await c.query(`UPDATE gpu_prices SET valid_during = tstzrange(lower(valid_during), now(), '[)') WHERE id = $1`, [cur.id]);
          const ins = await c.query<{ id: number }>(
            `INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
             VALUES ($1, $2, $3, $4::numeric, tstzrange(now(), NULL, '[)')) RETURNING id`,
            [key.dc, key.model, body.pricingType, body.pricePerHour],
          );
          id = ins.rows[0]!.id;
          changed = true;
        }
        const row = await c.query<GpuPriceRow>(`${GPU_PRICE_SQL} WHERE p.id = $1`, [id]);
        return { changed, price: priceDto(row.rows[0]!) };
      });
      req.log.info({ priceId: result.price.id, changed: result.changed }, 'admin: gpu price');
      res.status(result.changed ? 201 : 200).json(result);
    }),
  );

  // ---------------------------------------------------------------- инфраструктура

  // GET /api/admin/infrastructure — ДЦ -> ноды -> GPU
  router.get(
    '/infrastructure',
    wrap(async (req, res) => {
      const r = await withUser(userCtx(req), (c) =>
        c.query<InfraRow>(
          `SELECT d.code AS dc_code, d.name AS dc_name, d.city AS dc_city,
                  n.id AS node_id, n.hostname, n.status, n.cpu_cores, n.ram_gb,
                  g.id AS gpu_id, g.slot_index, g.serial, m.name AS model, g.is_enabled,
                  EXISTS (SELECT 1 FROM instance_gpus ig WHERE ig.gpu_id = g.id AND upper_inf(ig.allocated_during)) AS busy
           FROM datacenters d
           LEFT JOIN nodes n ON n.datacenter_id = d.id
           LEFT JOIN gpus g ON g.node_id = n.id
           LEFT JOIN gpu_models m ON m.id = g.gpu_model_id
           ORDER BY d.code, n.hostname, g.slot_index`,
        ),
      );
      res.json(buildInfrastructure(r.rows));
    }),
  );

  // POST /api/admin/gpus/:id/enable|disable
  for (const enable of [true, false]) {
    router.post(
      `/gpus/:id/${enable ? 'enable' : 'disable'}`,
      requireSession,
      wrap(async (req, res) => {
        const { id } = parse(idParams, req.params);
        const result = await withUser(userCtx(req), async (c) => {
          const cur = await c.query<{ is_enabled: boolean }>('SELECT is_enabled FROM gpus WHERE id = $1 FOR UPDATE', [id]);
          if (!cur.rows[0]) throw notFound('GPU не найдена');
          const changed = cur.rows[0].is_enabled !== enable;
          if (changed) {
            await c.query('UPDATE gpus SET is_enabled = $2 WHERE id = $1', [id, enable]);
            await writeAudit(c, enable ? 'gpu.enabled' : 'gpu.disabled', 'gpus', id, { from: !enable, to: enable });
          }
          return { id, isEnabled: enable, changed };
        });
        res.json(result);
      }),
    );
  }

  // POST /api/admin/nodes/:id/status {status}
  router.post(
    '/nodes/:id/status',
    requireSession,
    wrap(async (req, res) => {
      const { id } = parse(idParams, req.params);
      const body = parse(nodeStatusBody, req.body);
      const result = await withUser(userCtx(req), async (c) => {
        const cur = await c.query<{ status: string }>('SELECT status FROM nodes WHERE id = $1 FOR UPDATE', [id]);
        if (!cur.rows[0]) throw notFound('Нода не найдена');
        const changed = cur.rows[0].status !== body.status;
        if (changed) {
          await c.query('UPDATE nodes SET status = $2 WHERE id = $1', [id, body.status]);
          await writeAudit(c, 'node.status_changed', 'nodes', id, { from: cur.rows[0].status, to: body.status });
        }
        return { id, status: body.status, changed };
      });
      res.json(result);
    }),
  );

  // ---------------------------------------------------------------- пользователи

  // GET /api/admin/users?q=&limit=&offset= — массив; общее число подходящих — в заголовке X-Total-Count
  router.get(
    '/users',
    wrap(async (req, res) => {
      const q = parse(usersQuery, req.query);
      // % и _ из строки поиска не должны работать как шаблон
      const pattern = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null;
      const where = 'WHERE $1::text IS NULL OR email::text ILIKE $1 OR full_name ILIKE $1';
      const { rows, total } = await withUser(userCtx(req), async (c) => {
        const page = await c.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY id LIMIT $2 OFFSET $3`, [pattern, q.limit, q.offset]);
        const count = await c.query<{ n: number }>(`SELECT count(*) AS n FROM users ${where}`, [pattern]);
        return { rows: page.rows, total: count.rows[0]!.n };
      });
      res.set('X-Total-Count', String(total));
      res.json(rows.map(userDto));
    }),
  );

  async function setUserStatus(req: Request, status: 'active' | 'blocked') {
    const { id } = parse(idParams, req.params);
    return withUser(userCtx(req), async (c) => {
      try {
        // правила (только админ, себя нельзя, пользователь существует) проверяет функция БД; аудит пишет триггер
        await c.query('SELECT fn_admin_set_user_status($1, $2)', [id, status]);
      } catch (e) {
        if (sqlState(e) === 'GR003') throw conflict('Администратор не может менять статус своей учётной записи', 'INVALID_STATE');
        throw e;
      }
      req.log.info({ targetUserId: id, status }, 'admin: user status');
      const r = await c.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
      return userDto(r.rows[0]!);
    });
  }

  router.post('/users/:id/block', requireSession, wrap(async (req, res) => void res.json(await setUserStatus(req, 'blocked'))));
  router.post('/users/:id/unblock', requireSession, wrap(async (req, res) => void res.json(await setUserStatus(req, 'active'))));

  // ---------------------------------------------------------------- аудит

  // GET /api/admin/audit?cursor=&limit= — новые записи первыми, keyset по id
  router.get(
    '/audit',
    wrap(async (req, res) => {
      const q = parse(auditQuery, req.query);
      const after = q.cursor ? decodeCursor(q.cursor, auditCursor).id : null;
      const r = await withUser(userCtx(req), (c) =>
        c.query<AuditRow>(
          `SELECT a.id, a.action, a.entity, a.entity_id, a.actor_user_id, u.email AS actor_email,
                  a.details, host(a.ip) AS ip, a.created_at
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
           WHERE $1::bigint IS NULL OR a.id < $1
           ORDER BY a.id DESC LIMIT $2`,
          [after, q.limit + 1],
        ),
      );
      const page = r.rows.slice(0, q.limit);
      res.json({
        items: page.map((a) => ({
          id: a.id,
          action: a.action,
          entity: a.entity,
          entityId: a.entity_id,
          actor: a.actor_user_id === null ? null : { id: a.actor_user_id, email: a.actor_email ?? '' },
          details: a.details,
          ip: a.ip,
          createdAt: a.created_at.toISOString(),
        })),
        nextCursor: r.rows.length > q.limit ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
      });
    }),
  );

  return router;
}

// ---- разбор строк инфраструктуры и вспомогательные типы ----

interface UtilRow {
  key: string;
  name: string;
  total: number;
  busy: number;
  free: number;
  disabled: number;
}

interface AuditRow {
  id: number;
  action: string;
  entity: string;
  entity_id: string | null;
  actor_user_id: number | null;
  actor_email: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  created_at: Date;
}

interface InfraRow {
  dc_code: string;
  dc_name: string;
  dc_city: string;
  node_id: number | null;
  hostname: string | null;
  status: 'online' | 'maintenance' | 'offline' | null;
  cpu_cores: number | null;
  ram_gb: number | null;
  gpu_id: number | null;
  slot_index: number | null;
  serial: string | null;
  model: string | null;
  is_enabled: boolean | null;
  busy: boolean | null;
}

/** Плоский результат JOIN складывается в дерево ДЦ -> ноды -> GPU; порядок строк задан ORDER BY запроса. */
function buildInfrastructure(rows: InfraRow[]) {
  type Gpu = { id: number; slot: number; serial: string; model: string; isEnabled: boolean; busy: boolean };
  type Node = { id: number; hostname: string; status: 'online' | 'maintenance' | 'offline'; cpuCores: number; ramGb: number; gpus: Gpu[] };
  type Dc = { code: string; name: string; city: string; nodes: Node[] };
  const dcs = new Map<string, Dc>();
  const nodes = new Map<number, Node>();
  for (const r of rows) {
    let dc = dcs.get(r.dc_code);
    if (!dc) {
      dc = { code: r.dc_code, name: r.dc_name, city: r.dc_city, nodes: [] };
      dcs.set(r.dc_code, dc);
    }
    if (r.node_id === null) continue; // ДЦ без нод
    let node = nodes.get(r.node_id);
    if (!node) {
      node = { id: r.node_id, hostname: r.hostname!, status: r.status!, cpuCores: r.cpu_cores!, ramGb: r.ram_gb!, gpus: [] };
      nodes.set(r.node_id, node);
      dc.nodes.push(node);
    }
    if (r.gpu_id !== null) {
      node.gpus.push({ id: r.gpu_id, slot: r.slot_index!, serial: r.serial!, model: r.model!, isEnabled: r.is_enabled!, busy: r.busy! });
    }
  }
  return [...dcs.values()];
}

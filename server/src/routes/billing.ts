import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireUser } from '../auth/middleware';
import type { Config } from '../config';
import { decodeCursor, encodeCursor } from '../cursor';
import { withUser } from '../db';
import { badRequest } from '../errors';
import { NO_STORE, iso, userCtx, wrap } from '../http';
import { fromUnits, toUnits } from '../money';
import { idSchema, limitSchema, parse } from '../schemas';

const MAX_SPEND_DAYS = 366;

// Дата настоящая? 31 февраля JS молча превращает в март, а PostgreSQL такую строку отвергнет (был бы 500): сверяем обратным преобразованием. Год 0000 PostgreSQL тоже отвергает.
const isRealMoment = (s: string): boolean => {
  const t = Date.parse(s);
  return !Number.isNaN(t) && s >= '0001-01-01' && new Date(t).toISOString().slice(0, 10) === s.slice(0, 10);
};

// Момент в курсоре хранится с микросекундами: JS Date режет до миллисекунд, и при сравнении (created_at, id) строки терялись бы.
const cursorSchema = z.object({
  t: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/).refine(isRealMoment),
  id: idSchema,
});

const transactionsQuery = z.object({ cursor: z.string().max(200).optional(), limit: limitSchema });

const dateSchema = z.string().regex(/^\d{4}-\d\d-\d\d$/, 'Дата в формате ГГГГ-ММ-ДД').refine(isRealMoment, 'Такой даты нет');
const spendQuery = z.object({ from: dateSchema.optional(), to: dateSchema.optional() });

const DAY_MS = 24 * 3600 * 1000;
const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Сегодняшняя дата по Москве: так же, как «день» в mv_daily_revenue. */
const todayMoscow = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

const noStore = (_req: Request, res: Response, next: NextFunction): void => {
  res.set('Cache-Control', NO_STORE);
  next();
};

interface TxRow {
  id: number;
  type: 'topup' | 'charge' | 'refund' | 'bonus' | 'adjustment';
  amount: string;
  description: string;
  created_at: Date;
  cur_ts: string;
}

interface SpendRow {
  day: string;
  instance_id: string | null;
  name: string | null;
  amount: string;
}

export function billingRoutes(config: Config): Router {
  const router = Router();
  router.use('/billing', noStore, authenticate(config), requireUser);

  // GET /api/billing/balance — сперва начисляем за работу инстансов (биллинг «при обращении»), потом читаем баланс
  router.get(
    '/billing/balance',
    wrap(async (req, res) => {
      const out = await withUser(userCtx(req), async (c) => {
        const billed = await c.query<{ o_amount: string; o_stopped: number }>('SELECT o_amount::numeric(14,4)::text AS o_amount, o_stopped FROM fn_bill_current_user()');
        const bal = await c.query<{ balance: string }>('SELECT balance FROM users WHERE id = $1', [req.user!.id]);
        return { balance: bal.rows[0]!.balance, charged: billed.rows[0]!.o_amount, stopped: billed.rows[0]!.o_stopped };
      });
      res.json(out);
    }),
  );

  // GET /api/billing/transactions?cursor=&limit= — keyset по (created_at, id), новые сверху
  router.get(
    '/billing/transactions',
    wrap(async (req, res) => {
      const q = parse(transactionsQuery, req.query);
      const cur = q.cursor ? decodeCursor(q.cursor, cursorSchema) : undefined;
      const userId = req.user!.id;
      // user_id фильтруем сами: RLS показывает администратору операции всех пользователей, а здесь нужна история своего счёта
      const rows = await withUser(userCtx(req), async (c) => {
        const r = await c.query<TxRow>(
          `SELECT id, type, amount, description, created_at,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cur_ts
           FROM transactions
           WHERE user_id = $1
             AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::bigint))
           ORDER BY created_at DESC, id DESC
           LIMIT $4`,
          [userId, cur?.t ?? null, cur?.id ?? null, q.limit + 1], // лишняя строка нужна, чтобы узнать, есть ли следующая страница
        );
        return r.rows;
      });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      res.json({
        items: page.map((t) => ({ id: t.id, type: t.type, amount: t.amount, description: t.description, createdAt: iso(t.created_at) })),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.cur_ts, id: last.id }) : null,
      });
    }),
  );

  // GET /api/billing/spend?from=&to= — расходы по дням (Москва) и по инстансам; границы включительно, не больше 366 дней
  router.get(
    '/billing/spend',
    wrap(async (req, res) => {
      const q = parse(spendQuery, req.query);
      const to = q.to ?? todayMoscow();
      const from = q.from ?? addDays(to, -29);
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
      if (days < 1) throw badRequest('Дата «from» не может быть позже «to»', 'VALIDATION_ERROR');
      if (days > MAX_SPEND_DAYS) throw badRequest(`Период не больше ${MAX_SPEND_DAYS} дней`, 'VALIDATION_ERROR');

      // Один запрос (один снимок данных): итоги ниже складываются из его строк, поэтому всегда сходятся друг с другом.
      const rows = await withUser(userCtx(req), async (c) => {
        const r = await c.query<SpendRow>(
          `SELECT (u.period_start AT TIME ZONE 'Europe/Moscow')::date::text AS day,
                  u.instance_id, i.name, sum(u.amount)::text AS amount
           FROM usage_records u
           LEFT JOIN instances i ON i.id = u.instance_id
           WHERE u.user_id = $1
             AND u.period_start >= ($2::date)::timestamp AT TIME ZONE 'Europe/Moscow'
             AND u.period_start <  (($3::date) + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
           GROUP BY 1, u.instance_id, i.name`,
          [req.user!.id, from, to],
        );
        return r.rows;
      });

      const byDay = new Map<string, bigint>();
      const byInstance = new Map<string, { name: string; units: bigint }>();
      let total = 0n;
      let storage = 0n;
      for (const row of rows) {
        const units = toUnits(row.amount);
        total += units;
        byDay.set(row.day, (byDay.get(row.day) ?? 0n) + units);
        if (row.instance_id === null) {
          storage += units; // хранение томов: у него нет инстанса
        } else {
          const item = byInstance.get(row.instance_id) ?? { name: row.name ?? '', units: 0n };
          item.units += units;
          byInstance.set(row.instance_id, item);
        }
      }
      res.json({
        from,
        to,
        total: fromUnits(total),
        storage: fromUnits(storage),
        byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, units]) => ({ day, amount: fromUnits(units) })),
        byInstance: [...byInstance]
          .sort(([, a], [, b]) => (a.units === b.units ? 0 : a.units > b.units ? -1 : 1))
          .map(([instanceId, v]) => ({ instanceId, name: v.name, amount: fromUnits(v.units) })),
      });
    }),
  );

  return router;
}

import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, requireUser } from '../auth/middleware';
import type { Config } from '../config';
import { withUser } from '../db';
import { badRequest, conflict, notFound, unauthorized } from '../errors';
import { NO_STORE, iso, systemCtx, userCtx, wrap } from '../http';
import { createPaymentBody, decimalSchema, idParams, parse } from '../schemas';
import { signPayload, verifySignature } from '../webhook';

const MAX_PENDING_PAYMENTS = 10;

// Реальный шлюз (ЮKassa) подключался бы так же: свой provider и формат подписи, остальной путь тот же.
const PROVIDER = 'demo';

// Тело уведомления шлюза. Пользователя в нём нет намеренно: его берём из платежа в БД.
const notificationBody = z.object({
  paymentId: z.string().min(1).max(100),
  status: z.enum(['succeeded', 'failed']),
  amount: decimalSchema(2, 0.01, 999_999_999),
});

interface PaymentRow {
  id: number;
  amount: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  created_at: Date;
  paid_at: Date | null;
}

const PAYMENT_COLUMNS = 'id, amount, status, created_at, paid_at';

const paymentDto = (p: PaymentRow) => ({
  id: p.id,
  amount: p.amount,
  status: p.status,
  createdAt: iso(p.created_at),
  paidAt: iso(p.paid_at),
});

const noStore = (_req: Request, res: Response, next: NextFunction): void => {
  res.set('Cache-Control', NO_STORE);
  next();
};

function audit(c: PoolClient, req: Request, actorId: number | null, action: string, paymentId: number, details: object) {
  return c.query('INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [
    actorId,
    action,
    'payments',
    String(paymentId),
    JSON.stringify(details),
    req.ip !== undefined && isIP(req.ip) !== 0 ? req.ip : null,
  ]);
}

/**
 * Обработка уведомления шлюза. Один код и для HTTP-вебхука, и для демо-оплаты.
 * Подпись проверяется по сырым байтам тела; сумма сверяется с платежом в БД внутри fn_payment_confirm,
 * повторное уведомление зачисления не повторяет (идемпотентность — в fn_topup).
 */
async function applyNotification(req: Request, config: Config, raw: Buffer, signature: string | undefined) {
  if (!verifySignature(config.webhookSecret, raw, signature)) {
    throw unauthorized('Неверная подпись уведомления', 'INVALID_SIGNATURE');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw badRequest('Тело уведомления не является корректным JSON', 'INVALID_JSON');
  }
  const n = parse(notificationBody, json);

  return withUser(systemCtx(req), async (c) => {
    const r = await c.query<{ o_payment_id: number; o_user_id: number; o_status: PaymentRow['status']; o_credited: boolean }>(
      'SELECT * FROM fn_payment_confirm($1, $2, $3, $4)',
      [PROVIDER, n.paymentId, n.status, n.amount],
    );
    const row = r.rows[0]!;
    if (row.o_credited) await audit(c, req, null, 'payment.credited', row.o_payment_id, { user_id: row.o_user_id });
    return { paymentId: row.o_payment_id, status: row.o_status, credited: row.o_credited };
  });
}

export function paymentRoutes(config: Config): Router {
  const router = Router();
  const auth = authenticate(config);

  router.use(['/payments', '/webhooks/payments'], noStore);

  // POST /api/webhooks/payments — без входа: подлинность подтверждает подпись X-Signature
  router.post(
    '/webhooks/payments',
    wrap(async (req, res) => {
      // тело разобрано express.raw в app.ts; если запрос пришёл без тела/типа, там будет {}, и подпись не сойдётся
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await applyNotification(req, config, raw, req.header('x-signature'));
      req.log.info({ paymentId: result.paymentId, status: result.status, credited: result.credited }, 'payment notification');
      res.json({ ok: true, ...result });
    }),
  );

  // POST /api/payments — платёж создаётся только текущему пользователю
  router.post(
    '/payments',
    auth,
    requireUser,
    wrap(async (req, res) => {
      const body = parse(createPaymentBody, req.body);
      const user = req.user!;
      const payment = await withUser(userCtx(req), async (c) => {
        // Неоплаченные платежи никто не отменяет, поэтому за сутки их можно создать ограниченное число.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payments:${user.id}`]);
        const open = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payments WHERE user_id = $1 AND status = 'pending' AND created_at > now() - interval '1 day'`,
          [user.id],
        );
        if ((open.rows[0]?.n ?? 0) >= MAX_PENDING_PAYMENTS) {
          throw conflict(`Не более ${MAX_PENDING_PAYMENTS} неоплаченных платежей за сутки: завершите созданные`, 'LIMIT_REACHED');
        }
        // user_id берём из сессии, не из тела; RLS (p_payments) дополнительно не даст вставить чужого
        const r = await c.query<PaymentRow>(
          `INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES ($1, $2, $3, $4) RETURNING ${PAYMENT_COLUMNS}`,
          [user.id, PROVIDER, `demo_${randomUUID()}`, body.amount],
        );
        const p = r.rows[0]!;
        await audit(c, req, user.id, 'payment.create', p.id, { amount: p.amount });
        return p;
      });
      const base = config.appUrl ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`;
      res.status(201).json({ payment: paymentDto(payment), confirmationUrl: `${base}/billing?payment=${payment.id}` });
    }),
  );

  // POST /api/payments/:id/demo-pay — имитация шлюза: сервер сам шлёт себе подписанное уведомление
  router.post(
    '/payments/:id/demo-pay',
    (_req, _res, next) => (config.demoPayments ? next() : next(notFound('Такого адреса в API нет', 'ROUTE_NOT_FOUND'))),
    auth,
    requireUser,
    wrap(async (req, res) => {
      const { id } = parse(idParams, req.params);
      const userId = req.user!.id;
      // user_id проверяем явно: RLS показывает администратору платежи всех пользователей, а оплатить можно только свой
      const found = await withUser(userCtx(req), (c) =>
        c.query<{ provider_payment_id: string; amount: string }>('SELECT provider_payment_id, amount FROM payments WHERE id = $1 AND user_id = $2', [id, userId]),
      );
      const p = found.rows[0];
      if (!p) throw notFound('Платёж не найден');

      const raw = Buffer.from(JSON.stringify({ paymentId: p.provider_payment_id, status: 'succeeded', amount: p.amount }));
      const result = await applyNotification(req, config, raw, signPayload(config.webhookSecret, raw));

      const after = await withUser(userCtx(req), (c) =>
        c.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 AND user_id = $2`, [id, userId]),
      );
      res.json({ payment: paymentDto(after.rows[0]!), credited: result.credited });
    }),
  );

  return router;
}

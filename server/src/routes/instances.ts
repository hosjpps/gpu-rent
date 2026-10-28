import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from '../config';
import { withUser } from '../db';
import { forbidden, notFound } from '../errors';
import { NO_STORE, iso, userCtx, wrap } from '../http';
import type { AuthUser } from '../http';
import { authenticate, requireUser } from '../auth/middleware';
import { createInstanceBody, parse, uuidParams } from '../schemas';

interface InstanceRow {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'stopped' | 'terminated' | 'failed';
  gpu_count: number;
  pricing_type: 'on_demand' | 'spot';
  price: string;
  container_disk_gb: number;
  created_at: Date;
  started_at: Date | null;
  stopped_at: Date | null;
  terminated_at: Date | null;
  dc_code: string;
  dc_name: string;
  dc_city: string;
  model: string;
  template_id: number | null;
  template_name: string | null;
  volume_id: number | null;
  volume_name: string | null;
  volume_size_gb: number | null;
  ssh_key_id: number | null;
  ssh_key_name: string | null;
  owner_id: number | null;
  owner_email: string | null;
  env_names: string[];
}

// Шаблон и том берутся через LEFT JOIN: шаблон мог стать приватным, том — удалённым, а инстанс при этом должен остаться в списке.
// Значения переменных окружения здесь не читаются вообще: наружу уходят только имена.
const INSTANCE_SQL = `
  SELECT i.id, i.name, i.status, i.gpu_count, i.pricing_type, i.price_per_hour_snapshot AS price,
         i.container_disk_gb, i.created_at, i.started_at, i.stopped_at, i.terminated_at,
         d.code AS dc_code, d.name AS dc_name, d.city AS dc_city, m.name AS model,
         t.id AS template_id, t.name AS template_name,
         v.id AS volume_id, v.name AS volume_name, v.size_gb AS volume_size_gb,
         k.id AS ssh_key_id, k.name AS ssh_key_name,
         u.id AS owner_id, u.email AS owner_email,
         ARRAY(SELECT e.name FROM instance_env_vars e WHERE e.instance_id = i.id ORDER BY e.name) AS env_names
  FROM instances i
  JOIN nodes n ON n.id = i.node_id
  JOIN datacenters d ON d.id = n.datacenter_id
  JOIN gpu_models m ON m.id = i.gpu_model_id
  LEFT JOIN templates t ON t.id = i.template_id
  LEFT JOIN volumes v ON v.id = i.volume_id
  LEFT JOIN ssh_keys k ON k.id = i.ssh_key_id
  LEFT JOIN users u ON u.id = i.user_id`;

const LIST_LIMIT = 200;

function toInstance(r: InstanceRow, withOwner: boolean) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    datacenter: { code: r.dc_code, name: r.dc_name, city: r.dc_city },
    gpuModel: r.model,
    gpuCount: r.gpu_count,
    pricingType: r.pricing_type,
    pricePerHour: r.price,
    containerDiskGb: r.container_disk_gb,
    template: r.template_id === null ? null : { id: r.template_id, name: r.template_name },
    volume: r.volume_id === null ? null : { id: r.volume_id, name: r.volume_name, sizeGb: r.volume_size_gb },
    sshKey: r.ssh_key_id === null ? null : { id: r.ssh_key_id, name: r.ssh_key_name },
    envNames: r.env_names,
    createdAt: iso(r.created_at),
    startedAt: iso(r.started_at),
    stoppedAt: iso(r.stopped_at),
    terminatedAt: iso(r.terminated_at),
    ...(withOwner && r.owner_id !== null ? { owner: { id: r.owner_id, email: r.owner_email } } : {}),
  };
}

/** Один инстанс; чужой клиенту не виден (проверка владельца явная, RLS — вторая линия). Админ видит любой. */
async function loadInstance(client: PoolClient, id: string, user: AuthUser): Promise<InstanceRow | undefined> {
  const r = await client.query<InstanceRow>(`${INSTANCE_SQL} WHERE i.id = $1 AND (i.user_id = $2 OR $3::boolean)`, [
    id,
    user.id,
    user.role === 'admin',
  ]);
  return r.rows[0];
}

const FUNCTION_BY_ACTION = {
  stop: 'fn_stop_instance',
  resume: 'fn_resume_instance',
  terminate: 'fn_terminate_instance',
} as const;

const listQuery = z.object({ all: z.enum(['0', '1']).optional() });

export function instanceRoutes(config: Config): Router {
  const router = Router();
  // Только /instances: роутер подключён к /api целиком, и общий router.use зацепил бы чужие адреса.
  const guard: RequestHandler[] = [
    (_req, res, next) => {
      res.setHeader('Cache-Control', NO_STORE);
      next();
    },
    authenticate(config),
    requireUser,
  ];
  router.use('/instances', ...guard);

  // GET /api/instances — свои; админ с ?all=1 — все
  router.get(
    '/instances',
    wrap(async (req, res) => {
      const user = req.user!;
      const q = parse(listQuery, req.query);
      const all = user.role === 'admin' && q.all === '1';
      const rows = await withUser(userCtx(req), async (c) => {
        // Фонового процесса нет (serverless): начисляем при обращении, чтобы статус и баланс были честными.
        await c.query('SELECT * FROM fn_bill_current_user()');
        const r = await c.query<InstanceRow>(
          `${INSTANCE_SQL} WHERE ($1::boolean OR i.user_id = $2) ORDER BY i.created_at DESC LIMIT ${LIST_LIMIT}`,
          [all, user.id],
        );
        return r.rows;
      });
      res.json(rows.map((r) => toInstance(r, all)));
    }),
  );

  // GET /api/instances/:id
  router.get(
    '/instances/:id',
    wrap(async (req, res) => {
      const { id } = parse(uuidParams, req.params);
      const user = req.user!;
      const row = await withUser(userCtx(req), async (c) => {
        await c.query('SELECT * FROM fn_bill_current_user()'); // иначе только что автоостановленный инстанс ещё покажется работающим
        return loadInstance(c, id, user);
      });
      if (!row) throw notFound('Инстанс не найден');
      res.json(toInstance(row, user.role === 'admin'));
    }),
  );

  // POST /api/instances
  router.post(
    '/instances',
    wrap(async (req, res) => {
      const user = req.user!;
      if (!user.emailVerified) throw forbidden('Подтвердите email, чтобы запускать инстансы', 'EMAIL_NOT_VERIFIED');
      const b = parse(createInstanceBody, req.body);
      const row = await withUser(userCtx(req), async (c) => {
        const ref = await c.query<{ dc_id: number; model_id: number }>(
          'SELECT d.id AS dc_id, m.id AS model_id FROM datacenters d, gpu_models m WHERE d.code = $1 AND d.is_active AND m.name = $2',
          [b.datacenterCode, b.gpuModel],
        );
        if (!ref.rows[0]) throw notFound('Дата-центр или модель GPU не найдены');
        // Проверки (баланс, свободные GPU, шаблон, том, ключ) и выделение GPU — внутри функции БД, одной транзакцией.
        const started = await c.query<{ id: string }>(
          'SELECT fn_start_instance($1::bigint, $2::bigint, $3::bigint, $4::integer, $5::pricing_type, $6::bigint, $7::text, $8::integer, $9::bigint, $10::bigint) AS id',
          [user.id, ref.rows[0].dc_id, ref.rows[0].model_id, b.gpuCount, b.pricingType, b.templateId, b.name, b.containerDiskGb ?? null, b.volumeId ?? null, b.sshKeyId ?? null],
        );
        const id = started.rows[0]!.id;
        // Секреты шифруются в БД ключом из app.enc_key; если один из вызовов упадёт, откатится и сам запуск.
        for (const [name, value] of Object.entries(b.env ?? {})) {
          await c.query('SELECT fn_env_set($1::uuid, $2::text, $3::text)', [id, name, value]);
        }
        return loadInstance(c, id, user);
      });
      res.status(201).json(toInstance(row!, false));
    }),
  );

  // POST /api/instances/:id/stop | resume | terminate
  for (const action of ['stop', 'resume', 'terminate'] as const) {
    router.post(
      `/instances/:id/${action}`,
      wrap(async (req, res) => {
        const { id } = parse(uuidParams, req.params);
        const user = req.user!;
        const row = await withUser(userCtx(req), async (c) => {
          // Без этой проверки функция БД на чужой инстанс ответила бы 403, то есть подтвердила бы, что он существует.
          if (!(await loadInstance(c, id, user))) throw notFound('Инстанс не найден');
          await c.query(`SELECT ${FUNCTION_BY_ACTION[action]}($1::uuid)`, [id]);
          return loadInstance(c, id, user);
        });
        res.json(toInstance(row!, user.role === 'admin'));
      }),
    );
  }

  return router;
}

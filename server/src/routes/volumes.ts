import { Router } from 'express';
import type { RequestHandler } from 'express';
import type { PoolClient } from 'pg';
import type { Config } from '../config';
import { withUser } from '../db';
import { conflict, notFound, sqlState } from '../errors';
import { NO_STORE, iso, userCtx, wrap } from '../http';
import { authenticate, requireUser } from '../auth/middleware';
import { createVolumeBody, extendVolumeBody, idParams, parse } from '../schemas';

interface VolumeRow {
  id: number;
  name: string;
  size_gb: number;
  status: 'active' | 'deleted';
  created_at: Date;
  dc_code: string;
  dc_name: string;
  attached_id: string | null;
  attached_name: string | null;
}

// Том занят, пока у него есть живой инстанс; остановленный тоже держит том (так считает и БД).
const VOLUME_SQL = `
  SELECT v.id, v.name, v.size_gb, v.status, v.created_at, d.code AS dc_code, d.name AS dc_name,
         a.id AS attached_id, a.name AS attached_name
  FROM volumes v
  JOIN datacenters d ON d.id = v.datacenter_id
  LEFT JOIN LATERAL (
    SELECT i.id, i.name FROM instances i
    WHERE i.volume_id = v.id AND i.status IN ('pending', 'running', 'stopped') LIMIT 1
  ) a ON true`;

function toVolume(r: VolumeRow) {
  return {
    id: r.id,
    name: r.name,
    sizeGb: r.size_gb,
    datacenter: { code: r.dc_code, name: r.dc_name },
    status: r.status,
    attachedTo: r.attached_id === null ? null : { id: r.attached_id, name: r.attached_name },
    createdAt: iso(r.created_at),
  };
}

async function loadVolume(client: PoolClient, id: number, userId: number): Promise<VolumeRow | undefined> {
  const r = await client.query<VolumeRow>(`${VOLUME_SQL} WHERE v.id = $1 AND v.user_id = $2`, [id, userId]);
  return r.rows[0];
}

export function volumeRoutes(config: Config): Router {
  const router = Router();
  const guard: RequestHandler[] = [
    (_req, res, next) => {
      res.setHeader('Cache-Control', NO_STORE);
      next();
    },
    authenticate(config),
    requireUser,
  ];
  router.use('/volumes', ...guard);

  // GET /api/volumes — только свои активные; админ тоже видит свои, чужие тома ему не нужны
  router.get(
    '/volumes',
    wrap(async (req, res) => {
      const userId = req.user!.id;
      const rows = await withUser(userCtx(req), async (c) => {
        const r = await c.query<VolumeRow>(`${VOLUME_SQL} WHERE v.user_id = $1 AND v.status = 'active' ORDER BY v.created_at DESC, v.id DESC`, [userId]);
        return r.rows;
      });
      res.json(rows.map(toVolume));
    }),
  );

  // POST /api/volumes
  router.post(
    '/volumes',
    wrap(async (req, res) => {
      const userId = req.user!.id;
      const b = parse(createVolumeBody, req.body);
      const row = await withUser(userCtx(req), async (c) => {
        const dc = await c.query<{ id: number }>('SELECT id FROM datacenters WHERE code = $1 AND is_active', [b.datacenterCode]);
        if (!dc.rows[0]) throw notFound('Дата-центр не найден');
        const created = await c.query<{ id: number }>(
          'INSERT INTO volumes (user_id, datacenter_id, name, size_gb) VALUES ($1, $2, $3, $4) RETURNING id',
          [userId, dc.rows[0].id, b.name, b.sizeGb],
        );
        return loadVolume(c, created.rows[0]!.id, userId);
      });
      res.status(201).json(toVolume(row!));
    }),
  );

  // POST /api/volumes/:id/extend — sizeGb это новый общий размер; уменьшение запрещает триггер БД
  router.post(
    '/volumes/:id/extend',
    wrap(async (req, res) => {
      const userId = req.user!.id;
      const { id } = parse(idParams, req.params);
      const b = parse(extendVolumeBody, req.body);
      try {
        const row = await withUser(userCtx(req), async (c) => {
          // Сначала начисляем хранение по старому размеру: иначе новый размер задним числом лёг бы на весь непроведённый интервал.
          await c.query('SELECT * FROM fn_bill_current_user()');
          const upd = await c.query("UPDATE volumes SET size_gb = $3 WHERE id = $1 AND user_id = $2 AND status = 'active'", [id, userId, b.sizeGb]);
          if (upd.rowCount === 0) throw notFound('Том не найден');
          return loadVolume(c, id, userId);
        });
        res.json(toVolume(row!));
      } catch (e) {
        if (sqlState(e) === '23001') throw conflict('Размер тома можно только увеличивать', 'INVALID_STATE');
        throw e;
      }
    }),
  );

  // DELETE /api/volumes/:id — мягкое удаление; хранение дотарифицируется до момента удаления следующим проходом биллинга
  router.delete(
    '/volumes/:id',
    wrap(async (req, res) => {
      const userId = req.user!.id;
      const { id } = parse(idParams, req.params);
      try {
        await withUser(userCtx(req), async (c) => {
          const upd = await c.query(
            "UPDATE volumes SET status = 'deleted', deleted_at = clock_timestamp() WHERE id = $1 AND user_id = $2 AND status = 'active'",
            [id, userId],
          );
          if (upd.rowCount === 0) throw notFound('Том не найден');
        });
        res.status(204).end();
      } catch (e) {
        if (sqlState(e) === '23001') {
          throw conflict('Том подключён к инстансу (в том числе остановленному): сначала удалите инстанс', 'INVALID_STATE');
        }
        throw e;
      }
    }),
  );

  return router;
}

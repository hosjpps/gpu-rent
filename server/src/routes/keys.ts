import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config';
import { withUser } from '../db';
import { badRequest, conflict, notFound, sqlState } from '../errors';
import { NO_STORE, iso, requireSession, userCtx, wrap } from '../http';
import { authenticate, requireUser } from '../auth/middleware';
import { generateApiKey } from '../auth/tokens';
import { apiKeyBody, idParams, parse, parseSshPublicKey, sshKeyBody } from '../schemas';

// Потолки на пользователя: бесплатная БД мала, а без лимита один аккаунт мог бы забить таблицу.
const MAX_SSH_KEYS = 20;
const MAX_API_KEYS = 10;
const MAX_TEMPLATES = 20;

const templateBody = z
  .object({
    name: z.string().trim().min(1).max(64),
    // «репозиторий/образ:тег» без пробелов и схемы; полную проверку формата делает реестр при запуске
    dockerImage: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, 'Неверный формат имени образа')
      .refine((s) => !s.includes('://'), 'Имя образа без схемы (http://)'),
    defaultDiskGb: z.number().int().min(10).max(2000),
    defaultPorts: z
      .string()
      .trim()
      .max(100)
      .regex(/^$|^\d{1,5}\/(tcp|http)(,\d{1,5}\/(tcp|http))*$/, 'Порты в формате 22/tcp,8888/http')
      .refine((s) => s.split(',').every((p) => p === '' || (Number(p.split('/')[0]) >= 1 && Number(p.split('/')[0]) <= 65535)), 'Порт от 1 до 65535')
      .default(''),
  })
  .strict();

interface SshKeyRow {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
  created_at: Date;
}

interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

interface TemplateRow {
  id: number;
  name: string;
  docker_image: string;
  default_disk_gb: number;
  default_ports: string;
}

const sshKeyDto = (k: SshKeyRow) => ({
  id: k.id,
  name: k.name,
  fingerprint: k.fingerprint,
  publicKey: k.public_key,
  createdAt: k.created_at.toISOString(),
});

const apiKeyDto = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.key_prefix,
  createdAt: k.created_at.toISOString(),
  lastUsedAt: iso(k.last_used_at),
  expiresAt: iso(k.expires_at),
  revokedAt: iso(k.revoked_at),
});

const templateDto = (t: TemplateRow) => ({
  id: t.id,
  name: t.name,
  dockerImage: t.docker_image,
  defaultDiskGb: t.default_disk_gb,
  defaultPorts: t.default_ports,
  isPublic: false,
});

const SSH_COLUMNS = 'id, name, fingerprint, public_key, created_at';
const API_KEY_COLUMNS = 'id, name, key_prefix, created_at, last_used_at, expires_at, revoked_at';
const TEMPLATE_COLUMNS = 'id, name, docker_image, default_disk_gb, default_ports';

/**
 * Ключи и личные шаблоны пользователя. RLS пускает администратора ко всем строкам, поэтому в каждом запросе
 * владелец проверяется явно (user_id / owner_id = текущий): страница «Мои ключи» не должна показывать чужие.
 */
export function keyRoutes(config: Config): Router {
  const router = Router();
  const auth = authenticate(config);
  router.use(['/ssh-keys', '/api-keys', '/templates'], auth, requireUser, (_req, res, next) => {
    res.set('Cache-Control', NO_STORE);
    next();
  });

  // ---- SSH-ключи ----

  router.get(
    '/ssh-keys',
    wrap(async (req, res) => {
      const r = await withUser(userCtx(req), (c) =>
        c.query<SshKeyRow>(`SELECT ${SSH_COLUMNS} FROM ssh_keys WHERE user_id = $1 ORDER BY id DESC`, [req.user!.id]),
      );
      res.json(r.rows.map(sshKeyDto));
    }),
  );

  router.post(
    '/ssh-keys',
    wrap(async (req, res) => {
      const body = parse(sshKeyBody, req.body);
      const key = parseSshPublicKey(body.publicKey);
      if (!key) {
        throw badRequest('Некорректные данные запроса', 'VALIDATION_ERROR', [
          { path: 'publicKey', message: 'Нужен публичный ключ OpenSSH: ssh-ed25519, ssh-rsa или ecdsa-sha2-nistp256/384/521' },
        ]);
      }
      const created = await withUser(userCtx(req), async (c) => {
        // Блокировка на пользователя: параллельные запросы не должны вместе перешагнуть лимит.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ssh_keys:${req.user!.id}`]);
        const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM ssh_keys WHERE user_id = $1', [req.user!.id]);
        if ((n.rows[0]?.n ?? 0) >= MAX_SSH_KEYS) throw conflict(`Можно хранить не более ${MAX_SSH_KEYS} SSH-ключей`, 'LIMIT_REACHED');
        try {
          const r = await c.query<SshKeyRow>(
            `INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES ($1, $2, $3, $4) RETURNING ${SSH_COLUMNS}`,
            [req.user!.id, body.name, key.normalized, key.fingerprint],
          );
          return r.rows[0]!;
        } catch (e) {
          if (sqlState(e) === '23505') throw conflict('Такой SSH-ключ уже добавлен', 'SSH_KEY_EXISTS');
          throw e;
        }
      });
      res.status(201).json(sshKeyDto(created));
    }),
  );

  router.delete(
    '/ssh-keys/:id',
    wrap(async (req, res) => {
      const { id } = parse(idParams, req.params);
      // На инстансах ссылка на ключ обнуляется сама (ON DELETE SET NULL, миграция 0012).
      const r = await withUser(userCtx(req), (c) =>
        c.query('DELETE FROM ssh_keys WHERE id = $1 AND user_id = $2', [id, req.user!.id]),
      );
      if (r.rowCount === 0) throw notFound('SSH-ключ не найден');
      res.status(204).end();
    }),
  );

  // ---- API-ключи ----

  router.get(
    '/api-keys',
    wrap(async (req, res) => {
      const r = await withUser(userCtx(req), (c) =>
        c.query<ApiKeyRow>(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE user_id = $1 ORDER BY id DESC`, [req.user!.id]),
      );
      res.json(r.rows.map(apiKeyDto));
    }),
  );

  // Создание и отзыв — только из браузера по сессии: украденный API-ключ не должен уметь выпускать новые.
  router.post(
    '/api-keys',
    requireSession,
    wrap(async (req, res) => {
      const body = parse(apiKeyBody, req.body);
      const { key, prefix, hash } = generateApiKey();
      const created = await withUser(userCtx(req), async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`api_keys:${req.user!.id}`]);
        const n = await c.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())',
          [req.user!.id],
        );
        if ((n.rows[0]?.n ?? 0) >= MAX_API_KEYS) throw conflict(`Можно иметь не более ${MAX_API_KEYS} действующих API-ключей`, 'LIMIT_REACHED');
        const r = await c.query<ApiKeyRow>(
          `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING ${API_KEY_COLUMNS}`,
          [req.user!.id, body.name, prefix, hash, body.expiresAt ?? null],
        );
        const row = r.rows[0]!;
        await c.query(
          `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip)
           VALUES ($1, 'api_key.created', 'api_keys', $2, jsonb_build_object('name', $3::text), nullif(current_setting('app.client_ip', true), '')::inet)`,
          [req.user!.id, String(row.id), body.name],
        );
        return row;
      });
      // Полный ключ есть только в этом ответе: в БД лежит один SHA-256.
      res.status(201).json({ apiKey: apiKeyDto(created), key });
    }),
  );

  router.delete(
    '/api-keys/:id',
    requireSession,
    wrap(async (req, res) => {
      const { id } = parse(idParams, req.params);
      // Строка остаётся (в списке виден «отозван»); повторный отзыв успешен, но в аудит второй раз не пишется.
      const found = await withUser(userCtx(req), async (c) => {
        const r = await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, req.user!.id]);
        if (r.rowCount === 1) {
          await c.query(
            `INSERT INTO audit_log (actor_user_id, action, entity, entity_id, ip)
             VALUES ($1, 'api_key.revoked', 'api_keys', $2, nullif(current_setting('app.client_ip', true), '')::inet)`,
            [req.user!.id, String(id)],
          );
          return true;
        }
        const exists = await c.query('SELECT 1 FROM api_keys WHERE id = $1 AND user_id = $2', [id, req.user!.id]);
        return exists.rowCount === 1;
      });
      if (!found) throw notFound('API-ключ не найден');
      res.status(204).end();
    }),
  );

  // ---- Личные (приватные) шаблоны ----

  // Отдельно от публичного /catalog/templates: этот ответ персональный и никогда не кэшируется (no-store выше).
  router.get(
    '/templates/mine',
    wrap(async (req, res) => {
      const r = await withUser(userCtx(req), (c) =>
        c.query<TemplateRow>(`SELECT ${TEMPLATE_COLUMNS} FROM templates WHERE owner_id = $1 ORDER BY id`, [req.user!.id]),
      );
      res.json(r.rows.map(templateDto));
    }),
  );

  router.post(
    '/templates',
    wrap(async (req, res) => {
      const body = parse(templateBody, req.body);
      const created = await withUser(userCtx(req), async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`templates:${req.user!.id}`]);
        const n = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM templates WHERE owner_id = $1', [req.user!.id]);
        if ((n.rows[0]?.n ?? 0) >= MAX_TEMPLATES) throw conflict(`Можно создать не более ${MAX_TEMPLATES} личных шаблонов`, 'LIMIT_REACHED');
        // Владелец и признак публичности задаёт сервер, из тела они не читаются.
        const r = await c.query<TemplateRow>(
          `INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, default_ports, is_public)
           VALUES ($1, $2, $3, $4, $5, false) RETURNING ${TEMPLATE_COLUMNS}`,
          [req.user!.id, body.name, body.dockerImage, body.defaultDiskGb, body.defaultPorts],
        );
        return r.rows[0]!;
      });
      res.status(201).json(templateDto(created));
    }),
  );

  router.delete(
    '/templates/:id',
    wrap(async (req, res) => {
      const { id } = parse(idParams, req.params);
      // owner_id = текущий пользователь: публичные шаблоны (owner_id NULL) и чужие отсюда не удаляются.
      const r = await withUser(userCtx(req), async (c) => {
        try {
          return await c.query('DELETE FROM templates WHERE id = $1 AND owner_id = $2', [id, req.user!.id]);
        } catch (e) {
          if (sqlState(e) === '23503') throw conflict('Шаблон используется существующими инстансами', 'TEMPLATE_IN_USE');
          throw e;
        }
      });
      if (r.rowCount === 0) throw notFound('Шаблон не найден');
      res.status(204).end();
    }),
  );

  return router;
}

import { isIP } from 'node:net';
import { Pool, types } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import type { Config } from './config';

// bigint (id, count) приходит строкой; наши значения помещаются в Number без потери точности.
// numeric (деньги) намеренно остаётся строкой: JSON-число с плавающей точкой для денег не годится.
types.setTypeParser(20, (v) => Number(v));

export type DbRole = 'client' | 'admin' | 'system' | 'anon';

/** Кто выполняет запрос: попадает в set_config и определяет, что покажет RLS. */
export interface DbContext {
  userId?: number | undefined;
  role: DbRole;
  ip?: string | undefined;
}

let currentConfig: Config | undefined;
let pool: Pool | undefined;

/** Запоминает настройки подключения. Само подключение к БД не открывается до первого запроса. */
export function configureDb(config: Config): void {
  if (pool && currentConfig && currentConfig.databaseUrl !== config.databaseUrl) {
    throw new Error('Пул соединений уже создан для другой DATABASE_URL');
  }
  currentConfig = config;
}

export function getPool(): Pool {
  if (!pool) {
    if (!currentConfig) throw new Error('База данных не настроена: сначала вызовите createApp()');
    // Пул на уровне модуля: в serverless-функции он переживает несколько вызовов подряд.
    // Лимит маленький, потому что у Neon (и у бесплатного Postgres вообще) число соединений ограничено.
    pool = new Pool({
      connectionString: currentConfig.databaseUrl,
      max: currentConfig.poolMax,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    // Ошибка простаивающего соединения (обрыв, перезапуск Neon) не должна ронять процесс.
    pool.on('error', () => undefined);
    if (process.env.VERCEL) attachDatabasePool(pool);
  }
  return pool;
}

/** Есть ли уже пул (нужно тестам: импорт приложения не должен открывать соединений). */
export function isPoolCreated(): boolean {
  return pool !== undefined;
}

export async function closePool(): Promise<void> {
  const p = pool;
  pool = undefined;
  if (p) await p.end();
}

export function query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params);
}

/**
 * Одна транзакция на одном соединении с контекстом пользователя для RLS и функций БД.
 * set_config(..., true) действует до конца транзакции, поэтому соединение, вернувшееся в пул,
 * не уносит чужой app.user_id. Внутри fn нельзя использовать pool.query: он взял бы другое соединение без контекста.
 */
export async function withUser<T>(ctx: DbContext, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let broken = false;
  // Пока клиент выдан из пула, пул его ошибок не слушает: обрыв соединения посреди запроса (рестарт или усыпление Neon)
  // без своего обработчика стал бы необработанным событием 'error' и завершил бы процесс.
  const onClientError = (): void => {
    broken = true;
  };
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true), set_config($7, $8, true)', [
      'app.user_id', ctx.userId === undefined ? '' : String(ctx.userId),
      'app.user_role', ctx.role === 'anon' ? '' : ctx.role,
      'app.client_ip', ctx.ip !== undefined && isIP(ctx.ip) !== 0 ? ctx.ip : '',
      'app.enc_key', currentConfig?.encKey ?? '',
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // соединение умерло: пусть пул его выбросит, а не вернёт в оборот
    }
    throw e;
  } finally {
    client.removeListener('error', onClientError);
    client.release(broken);
  }
}

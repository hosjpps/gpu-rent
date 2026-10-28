import { afterAll, describe, expect, it } from 'vitest';
import { costForSeconds, hourlyCost } from '../../src/money';
import { closeAll, sql } from './helpers';

afterAll(closeAll);

// Расчёт в приложении (BigInt) должен давать те же копейки, что round(price * seconds / 3600, 4) в PostgreSQL:
// иначе сумма на экране разошлась бы с реально списанной.
describe('расчёт стоимости: приложение и БД считают одинаково', () => {
  const prices = ['0.0001', '0.0003', '1.0000', '12.3456', '45.4800', '77.2500', '293.5500', '535.6000', '99999.9999'];
  const seconds = [0, 1, 7, 59, 60, 61, 1799, 1800, 3599, 3600, 3601, 4321, 86_399, 86_400, 604_800, 7_776_000];

  it('costForSeconds совпадает с round(numeric) на всех сочетаниях цен и интервалов', async () => {
    const pairs = prices.flatMap((p) => seconds.map((s) => [p, s] as const));
    const rows = await sql<{ price: string; sec: number; db: string }>(
      'SELECT p AS price, s AS sec, round(p::numeric * s / 3600, 4)::text AS db FROM unnest($1::text[], $2::int[]) AS t(p, s)',
      [pairs.map(([p]) => p), pairs.map(([, s]) => s)],
    );
    expect(rows).toHaveLength(pairs.length);
    for (const r of rows) expect(costForSeconds(r.price, r.sec), `${r.price} x ${r.sec} c`).toBe(r.db.includes('.') ? r.db.padEnd(r.db.indexOf('.') + 5, '0') : `${r.db}.0000`);
  });

  it('на случайных данных расхождений нет', async () => {
    const pairs = Array.from({ length: 300 }, () => [((Math.floor(Math.random() * 10_000_000) + 1) / 10_000).toFixed(4), Math.floor(Math.random() * 2_000_000)] as const);
    const rows = await sql<{ price: string; sec: number; db: string }>(
      'SELECT p AS price, s AS sec, round(p::numeric * s / 3600, 4)::text AS db FROM unnest($1::text[], $2::int[]) AS t(p, s)',
      [pairs.map(([p]) => p), pairs.map(([, s]) => s)],
    );
    const wrong = rows.filter((r) => costForSeconds(r.price, r.sec) !== r.db);
    expect(wrong).toEqual([]);
  });

  it('hourlyCost совпадает с price * gpu_count в БД (так считает _fn_quote_instance)', async () => {
    const rows = await sql<{ price: string; n: number; db: string }>(
      'SELECT p AS price, n, (p::numeric * n)::text AS db FROM unnest($1::text[]) AS p, generate_series(1, 8) AS n',
      [prices],
    );
    for (const r of rows) expect(hourlyCost(r.price, r.n)).toBe(r.db);
  });
});

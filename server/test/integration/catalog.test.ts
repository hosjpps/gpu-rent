import { afterAll, describe, expect, it } from 'vitest';
import { closeAll, makeApp, bare, sql } from './helpers';

const app = makeApp();
afterAll(closeAll);

describe('каталог GPU', () => {
  it('содержит ровно то, что показывает представление v_gpu_availability, по строкам и числам', async () => {
    const res = await bare(app).get('/api/catalog/gpus');
    expect(res.status).toBe(200);
    const view = await sql<{ dc: string; model: string; total: number; free: number; od: string | null; spot: string | null }>(
      'SELECT datacenter_code AS dc, gpu_model AS model, total_gpus AS total, free_gpus AS free, price_on_demand AS od, price_spot AS spot FROM v_gpu_availability ORDER BY datacenter_code, gpu_model',
    );
    expect(res.body).toHaveLength(view.length);
    expect(res.body).toHaveLength(18);
    res.body.forEach((row: Record<string, any>, i: number) => {
      const v = view[i]!;
      expect(row.datacenter.code).toBe(v.dc);
      expect(row.model.name).toBe(v.model);
      expect(row.total).toBe(v.total);
      expect(row.free).toBe(v.free);
      expect(row.priceOnDemand).toBe(v.od);
      expect(row.priceSpot).toBe(v.spot);
    });
  });

  it('форма строки: ДЦ с городом, модель с объёмом памяти, цены строками с четырьмя знаками', async () => {
    const res = await bare(app).get('/api/catalog/gpus');
    for (const row of res.body) {
      expect(row).toEqual({
        datacenter: { code: expect.stringMatching(/^[A-Z]{3}-\d$/), name: expect.any(String), city: expect.any(String) },
        model: { name: expect.any(String), vramGb: expect.any(Number) },
        total: expect.any(Number),
        free: expect.any(Number),
        priceOnDemand: expect.stringMatching(/^\d+\.\d{4}$/),
        priceSpot: expect.stringMatching(/^\d+\.\d{4}$/),
      });
      expect(row.free).toBeGreaterThanOrEqual(0);
      expect(row.free).toBeLessThanOrEqual(row.total);
      expect(Number(row.priceSpot)).toBeLessThan(Number(row.priceOnDemand));
    }
  });

  it('стабильный порядок: по дата-центру, затем по модели', async () => {
    const res = await bare(app).get('/api/catalog/gpus');
    const keys = res.body.map((r: { datacenter: { code: string }; model: { name: string } }) => `${r.datacenter.code}|${r.model.name}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('каталог шаблонов', () => {
  it('только публичные шаблоны в порядке id, с полями, которые ждёт фронтенд', async () => {
    const res = await bare(app).get('/api/catalog/templates');
    expect(res.status).toBe(200);
    const db = await sql<{ id: number; name: string }>('SELECT id, name FROM templates WHERE is_public ORDER BY id');
    expect(res.body.map((t: { id: number }) => t.id)).toEqual(db.map((t) => t.id));
    expect(res.body).toHaveLength(8);
    for (const t of res.body) {
      expect(t).toEqual({ id: expect.any(Number), name: expect.any(String), dockerImage: expect.any(String), defaultDiskGb: expect.any(Number), defaultPorts: expect.any(String), isPublic: true });
    }
  });

  it('приватные шаблоны seed-пользователей в публичный список не попадают', async () => {
    const res = await bare(app).get('/api/catalog/templates');
    expect(JSON.stringify(res.body)).not.toContain('my-env-');
  });
});

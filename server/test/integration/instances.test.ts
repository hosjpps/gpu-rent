import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ENC_KEY, balanceOf, closeAll, launch, launchBody, makeApp, newUser, owner, pickOffer, bare, sql, terminateAllInstances, topUp, uniq } from './helpers';
import type { Offer, TestUser } from './helpers';
import { hourlyCost } from '../../src/money';

const app = makeApp();
let offer: Offer; // много свободных GPU: обычные тесты не мешают друг другу
let scarce: Offer; // мало свободных GPU: на нём проверяется нехватка мощностей

beforeAll(async () => {
  offer = await pickOffer(app, 8);
  scarce = await pickOffer(app, 1, 7);
});
afterAll(closeAll);

const openGpus = async (id: string): Promise<number> =>
  (await sql<{ n: number }>('SELECT count(*)::int AS n FROM instance_gpus WHERE instance_id = $1 AND upper_inf(allocated_during)', [id]))[0]!.n;

async function freeGpus(o: Offer): Promise<number> {
  const res = await bare(app).get('/api/catalog/gpus');
  const row = (res.body as { datacenter: { code: string }; model: { name: string }; free: number }[]).find((r) => r.datacenter.code === o.dc && r.model.name === o.model);
  return row!.free;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('запуск инстанса', () => {
  let user: TestUser;
  beforeAll(async () => {
    user = await newUser(app, { balance: 5000 });
  });
  afterEach(() => terminateAllInstances(user));

  it('201: форма ответа как ждёт фронтенд, цена — снимок «цена GPU × число GPU», GPU выделены, баланс не тронут', async () => {
    const free0 = await freeGpus(offer);
    const balance0 = await balanceOf(user.id);
    const { id, body } = await launch(user, offer, { gpuCount: 2, name: 'train-1', containerDiskGb: 80 });

    expect(id).toMatch(UUID);
    expect(body).toMatchObject({
      name: 'train-1',
      status: 'running',
      datacenter: { code: offer.dc, name: expect.any(String), city: expect.any(String) },
      gpuModel: offer.model,
      gpuCount: 2,
      pricingType: 'on_demand',
      pricePerHour: hourlyCost(offer.priceOnDemand, 2),
      containerDiskGb: 80,
      template: { id: 1, name: expect.any(String) },
      volume: null,
      sshKey: null,
      envNames: [],
      stoppedAt: null,
      terminatedAt: null,
    });
    expect(Date.parse(body.startedAt)).toBeGreaterThan(Date.now() - 10_000);
    expect(Date.parse(body.createdAt)).toBeGreaterThan(Date.now() - 10_000);
    expect(body.owner).toBeUndefined(); // владелец показывается только админу при ?all=1
    expect(JSON.stringify(body)).not.toMatch(/user_?id|node_?id|gpu_?ids/i);

    expect(await openGpus(id)).toBe(2);
    const alloc = await sql<{ nodes: number; models: number }>(
      `SELECT count(DISTINCT g.node_id)::int AS nodes, count(DISTINCT g.gpu_model_id)::int AS models
       FROM instance_gpus ig JOIN gpus g ON g.id = ig.gpu_id WHERE ig.instance_id = $1`,
      [id],
    );
    expect(alloc[0]).toEqual({ nodes: 1, models: 1 }); // обе GPU на одной ноде и одной модели
    expect(await freeGpus(offer)).toBe(free0 - 2);
    expect(await balanceOf(user.id)).toBe(balance0); // списания начнутся с первого обращения после минуты работы
  });

  it('spot-цена берётся из тарифа spot', async () => {
    const { body } = await launch(user, offer, { pricingType: 'spot' });
    expect(body.pricingType).toBe('spot');
    expect(body.pricePerHour).toBe(hourlyCost(offer.priceSpot, 1));
  });

  it('переменные окружения: наружу только имена, в БД значения зашифрованы ключом приложения', async () => {
    const secret = `hf_${uniq()}_very_secret`;
    const { id, body } = await launch(user, offer, { env: { HF_TOKEN: secret, MODE: 'train' } });
    expect(body.envNames).toEqual(['HF_TOKEN', 'MODE']);
    for (const res of [await user.api.get(`/api/instances/${id}`), await user.api.get('/api/instances')]) {
      expect(JSON.stringify(res.body)).not.toContain(secret);
      expect(JSON.stringify(res.body)).not.toMatch(/"env"|"train"/); // ни поля env, ни значений остальных переменных
    }
    const rows = await sql<{ name: string; text_value: string }>("SELECT name, encode(value_encrypted, 'escape') AS text_value FROM instance_env_vars WHERE instance_id = $1 ORDER BY name", [id]);
    expect(rows.map((r) => r.name)).toEqual(['HF_TOKEN', 'MODE']);
    expect(JSON.stringify(rows)).not.toContain(secret);
    // расшифровка тем же ключом возвращает исходное значение
    const c = await owner().connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.user_role', 'client', true), set_config('app.enc_key', $2, true)", [String(user.id), ENC_KEY]);
      const dec = await c.query<{ v: string }>('SELECT fn_env_get($1::uuid, $2) AS v', [id, 'HF_TOKEN']);
      expect(dec.rows[0]!.v).toBe(secret);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('без подтверждённого email — 403 EMAIL_NOT_VERIFIED, даже при достаточном балансе; после подтверждения запуск проходит', async () => {
    const u = await newUser(app, { verify: false, balance: 5000 });
    const free0 = await freeGpus(offer);
    const res = await u.api.post('/api/instances', launchBody(offer));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(await freeGpus(offer)).toBe(free0);

    const resend = await u.api.post('/api/auth/resend');
    const token = new URL(resend.body.verifyUrl).searchParams.get('token');
    await bare(app).post('/api/auth/verify').set('X-Requested-With', 'fetch').set('Origin', 'http://localhost:3000').send({ token });
    expect((await u.api.post('/api/instances', launchBody(offer))).status).toBe(201);
  });

  it('нехватка средств — 402 INSUFFICIENT_FUNDS, ничего не создаётся', async () => {
    const u = await newUser(app); // баланс 0
    const res = await u.api.post('/api/instances', launchBody(offer));
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(res.body.error.message).toMatch(/[А-Яа-я]/);
    expect(await sql('SELECT 1 FROM instances WHERE user_id = $1', [u.id])).toHaveLength(0);
  });

  it('граница баланса: ровно стоимость первого часа — запуск проходит, на копейку меньше — 402', async () => {
    const cost = Number(hourlyCost(offer.priceOnDemand, 1));
    const edge = await newUser(app);
    await topUp(edge.api, cost.toFixed(2));
    expect(Number(await balanceOf(edge.id))).toBeCloseTo(cost, 4);
    expect((await edge.api.post('/api/instances', launchBody(offer))).status).toBe(201);

    const short = await newUser(app);
    await topUp(short.api, (cost - 0.01).toFixed(2));
    expect((await short.api.post('/api/instances', launchBody(offer))).status).toBe(402);
  });

  it('запуск и возобновление начисляют за работающие инстансы до проверки баланса', async () => {
    const cost = Number(hourlyCost(offer.priceOnDemand, 1));
    const u = await newUser(app);
    await topUp(u.api, Math.ceil(cost * 1.5));
    const first = await launch(u, offer);
    const stopped = await launch(u, offer);
    expect((await u.api.post(`/api/instances/${stopped.id}/stop`)).status).toBe(200);
    // 10 часов работы первого инстанса: реальный долг, которого баланс в таблице ещё не отражает
    await sql("UPDATE instances SET last_billed_at = now() - interval '10 hours' WHERE id = $1", [first.id]);
    const res = await u.api.post('/api/instances', launchBody(offer));
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await u.api.post(`/api/instances/${stopped.id}/resume`)).status).toBe(402);
    await terminateAllInstances(u);
  });

  it('нет свободных GPU — 409 NO_CAPACITY; после завершения чужого инстанса место появляется', async () => {
    const rich = await newUser(app, { balance: 100_000 });
    const taken: string[] = [];
    const free = await freeGpus(scarce);
    for (let i = 0; i < free; i++) taken.push((await launch(rich, scarce)).id);
    expect(await freeGpus(scarce)).toBe(0);

    const other = await newUser(app, { balance: 5000 });
    const full = await other.api.post('/api/instances', launchBody(scarce));
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('NO_CAPACITY');
    expect(await sql('SELECT 1 FROM instances WHERE user_id = $1', [other.id])).toHaveLength(0);

    expect((await rich.api.post(`/api/instances/${taken[0]}/terminate`)).status).toBe(200);
    expect(await freeGpus(scarce)).toBe(1);
    expect((await other.api.post('/api/instances', launchBody(scarce))).status).toBe(201);
    expect(await freeGpus(scarce)).toBe(0);
  });

  it('запрос больше, чем свободно в ДЦ, — 409 NO_CAPACITY, GPU не занимаются частично', async () => {
    const rich = await newUser(app, { balance: 100_000 });
    const before = await freeGpus(scarce);
    const res = await rich.api.post('/api/instances', launchBody(scarce, { gpuCount: 8 }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_CAPACITY');
    expect(await freeGpus(scarce)).toBe(before);
  });

  it('некорректные данные — 400 VALIDATION_ERROR и ничего не запускается', async () => {
    const before = await freeGpus(offer);
    const bad: Record<string, unknown>[] = [
      { name: '' },
      { gpuCount: 0 },
      { gpuCount: 9 },
      { gpuCount: 1.5 },
      { gpuCount: '1' },
      { pricingType: 'reserved' },
      { datacenterCode: 'x' },
      { templateId: 'abc' },
      { containerDiskGb: 5 },
      { env: { 'BAD NAME': 'x' } },
    ];
    for (const over of bad) {
      const res = await user.api.post('/api/instances', launchBody(offer, over));
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await user.api.post('/api/instances', {})).status).toBe(400);
    expect(await freeGpus(offer)).toBe(before);
  });

  it.each([['userId', 1], ['status', 'running'], ['price', '0.0001'], ['pricePerHour', '0.0001'], ['nodeId', 1], ['gpuIds', [1, 2]], ['role', 'admin']])(
    'лишнее поле %s отклоняется: цену, узел и владельца задаёт сервер',
    async (field, value) => {
      const res = await user.api.post('/api/instances', launchBody(offer, { [field]: value }));
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].message).toBe('Лишние поля в запросе');
    },
  );

  it('неизвестный дата-центр, модель GPU или шаблон — 404', async () => {
    expect((await user.api.post('/api/instances', launchBody(offer, { datacenterCode: 'XXX-9' }))).status).toBe(404);
    expect((await user.api.post('/api/instances', launchBody(offer, { gpuModel: 'Несуществующая GPU' }))).status).toBe(404);
    expect((await user.api.post('/api/instances', launchBody(offer, { templateId: 999_999 }))).status).toBe(404);
  });

  it('без входа — 401', async () => {
    expect((await bare(app).post('/api/instances').set('X-Requested-With', 'fetch').set('Origin', 'http://localhost:3000').send(launchBody(offer))).status).toBe(401);
  });
});

describe('жизненный цикл: остановка, возобновление, завершение', () => {
  it('stop -> resume -> terminate: статусы, аллокации GPU, каталог и баланс', async () => {
    const u = await newUser(app, { balance: 5000 });
    const free0 = await freeGpus(offer);
    const { id } = await launch(u, offer, { gpuCount: 2 });
    const hourly = Number(hourlyCost(offer.priceOnDemand, 2));
    expect(await openGpus(id)).toBe(2);
    expect(await freeGpus(offer)).toBe(free0 - 2);

    // 30 минут работы
    await sql("UPDATE instances SET started_at = now() - interval '30 minutes', created_at = now() - interval '30 minutes', last_billed_at = now() - interval '30 minutes' WHERE id = $1", [id]);
    const balanceBefore = Number(await balanceOf(u.id));

    const stop = await u.api.post(`/api/instances/${id}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe('stopped');
    expect(stop.body.stoppedAt).not.toBeNull();
    expect(await openGpus(id)).toBe(0);
    expect(await freeGpus(offer)).toBe(free0);
    const charged = balanceBefore - Number(await balanceOf(u.id));
    expect(charged).toBeGreaterThan(hourly * 0.5 * 0.99);
    expect(charged).toBeLessThan(hourly * 0.5 * 1.05);
    const charges = await sql<{ amount: string; description: string }>("SELECT amount, description FROM transactions WHERE user_id = $1 AND type = 'charge'", [u.id]);
    expect(charges).toHaveLength(1);
    expect(Number(charges[0]!.amount)).toBeCloseTo(-charged, 3);

    // остановленный не может быть остановлен ещё раз
    const again = await u.api.post(`/api/instances/${id}/stop`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');

    // остановленный инстанс не стоит денег
    const idle = await u.api.get('/api/billing/balance');
    expect(Number(idle.body.balance)).toBeCloseTo(balanceBefore - charged, 4);
    expect(idle.body.charged).toBe('0.0000');

    const resume = await u.api.post(`/api/instances/${id}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.body.status).toBe('running');
    expect(await openGpus(id)).toBe(2);
    expect(await freeGpus(offer)).toBe(free0 - 2);
    expect((await u.api.post(`/api/instances/${id}/resume`)).status).toBe(409);

    const term = await u.api.post(`/api/instances/${id}/terminate`);
    expect(term.status).toBe(200);
    expect(term.body.status).toBe('terminated');
    expect(term.body.terminatedAt).not.toBeNull();
    expect(await openGpus(id)).toBe(0);
    expect(await freeGpus(offer)).toBe(free0);

    for (const action of ['stop', 'resume', 'terminate']) {
      const res = await u.api.post(`/api/instances/${id}/${action}`);
      expect(res.status, action).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
    }
    // история аллокаций сохранена: строки закрыты, а не удалены
    const history = await sql<{ n: number }>('SELECT count(*)::int AS n FROM instance_gpus WHERE instance_id = $1', [id]);
    expect(history[0]!.n).toBe(4);
  });

  it('завершение остановленного инстанса и завершение работающего с дотарификацией', async () => {
    const u = await newUser(app, { balance: 5000 });
    const stopped = await launch(u, offer);
    await u.api.post(`/api/instances/${stopped.id}/stop`);
    const t1 = await u.api.post(`/api/instances/${stopped.id}/terminate`);
    expect(t1.status).toBe(200);
    expect(t1.body.status).toBe('terminated');

    const running = await launch(u, offer);
    await sql("UPDATE instances SET started_at = now() - interval '1 hour', created_at = now() - interval '1 hour', last_billed_at = now() - interval '1 hour' WHERE id = $1", [running.id]);
    const before = Number(await balanceOf(u.id));
    const t2 = await u.api.post(`/api/instances/${running.id}/terminate`);
    expect(t2.status).toBe(200);
    const spent = before - Number(await balanceOf(u.id));
    expect(spent).toBeGreaterThan(Number(offer.priceOnDemand) * 0.99);
    expect(spent).toBeLessThan(Number(offer.priceOnDemand) * 1.05);
  });

  it('списки и просмотр: свои инстансы, новые сверху; не-uuid — 400, неизвестный uuid — 404', async () => {
    const u = await newUser(app, { balance: 5000 });
    const first = await launch(u, offer, { name: 'first' });
    const second = await launch(u, offer, { name: 'second' });
    const list = await u.api.get('/api/instances');
    expect(list.status).toBe(200);
    expect(list.body.map((i: { name: string }) => i.name)).toEqual(['second', 'first']);
    const one = await u.api.get(`/api/instances/${first.id}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(first.id);
    expect((await u.api.get('/api/instances/not-a-uuid')).status).toBe(400);
    expect((await u.api.get('/api/instances/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await u.api.post('/api/instances/00000000-0000-4000-8000-000000000000/stop')).status).toBe(404);
    expect(second.id).not.toBe(first.id);
  });

  it('лимит списка не скрывает работающий инстанс: активные идут раньше завершённых', async () => {
    const u = await newUser(app, { balance: 5000 });
    const running = await launch(u, offer, { name: 'old-running' });
    const done = await launch(u, offer, { name: 'done' });
    expect((await u.api.post(`/api/instances/${done.id}/terminate`)).status).toBe(200);
    await sql(
      `INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, name, pricing_type, gpu_count, container_disk_gb,
                              price_per_hour_snapshot, status, created_at, terminated_at)
       SELECT user_id, node_id, gpu_model_id, template_id, 'bulk-' || g, pricing_type, gpu_count, container_disk_gb,
              price_per_hour_snapshot, 'terminated', now() + g * interval '1 second', now()
       FROM instances, generate_series(1, 205) g WHERE id = $1`,
      [done.id],
    );
    const list = await u.api.get('/api/instances');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(200);
    expect(list.body[0].id).toBe(running.id);
    expect(list.body.filter((i: { status: string }) => i.status === 'running')).toHaveLength(1);
  });

  it('?all=1 клиенту ничего лишнего не открывает', async () => {
    const u = await newUser(app, { balance: 5000 });
    await launch(u, offer);
    const res = await u.api.get('/api/instances?all=1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].owner).toBeUndefined();
    expect((await u.api.get('/api/instances?all=2')).status).toBe(400);
  });
});

describe('конкурентные операции', () => {
  it('борьба за последние GPU: успешных запусков ровно столько, сколько свободно, остальные — NO_CAPACITY; GPU не выдаются дважды', async () => {
    const free = await freeGpus(scarce);
    const users: TestUser[] = [];
    for (let i = 0; i < free + 3; i++) users.push(await newUser(app, { balance: 5000 }));
    const results = await Promise.all(users.map((u) => u.api.post('/api/instances', launchBody(scarce))));
    const ok = results.filter((r) => r.status === 201);
    const full = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(free);
    expect(full).toHaveLength(3);
    expect(full.every((r) => r.body.error.code === 'NO_CAPACITY')).toBe(true);
    expect(await freeGpus(scarce)).toBe(0);

    const ids = ok.map((r) => r.body.id);
    const gpus = await sql<{ gpu_id: number; n: number }>(
      'SELECT gpu_id, count(*)::int AS n FROM instance_gpus WHERE instance_id = ANY($1::uuid[]) AND upper_inf(allocated_during) GROUP BY gpu_id',
      [ids],
    );
    expect(gpus).toHaveLength(free);
    expect(gpus.every((g) => g.n === 1)).toBe(true); // одна GPU — один живой инстанс
  });

  it('повторные одновременные остановка и завершение: одна операция успешна, остальные — 409, списание одно', async () => {
    const u = await newUser(app, { balance: 5000 });
    const { id } = await launch(u, offer);
    await sql("UPDATE instances SET started_at = now() - interval '1 hour', created_at = now() - interval '1 hour', last_billed_at = now() - interval '1 hour' WHERE id = $1", [id]);

    const stops = await Promise.all(Array.from({ length: 5 }, () => u.api.post(`/api/instances/${id}/stop`)));
    expect(stops.filter((r) => r.status === 200)).toHaveLength(1);
    expect(stops.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await sql("SELECT 1 FROM transactions WHERE user_id = $1 AND type = 'charge'", [u.id])).toHaveLength(1);

    const terms = await Promise.all(Array.from({ length: 5 }, () => u.api.post(`/api/instances/${id}/terminate`)));
    expect(terms.filter((r) => r.status === 200)).toHaveLength(1);
    expect(terms.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await openGpus(id)).toBe(0);
  });

  it('параллельное возобновление одного инстанса занимает GPU один раз', async () => {
    const u = await newUser(app, { balance: 5000 });
    const { id } = await launch(u, offer);
    await u.api.post(`/api/instances/${id}/stop`);
    const free0 = await freeGpus(offer);
    const resumes = await Promise.all(Array.from({ length: 4 }, () => u.api.post(`/api/instances/${id}/resume`)));
    expect(resumes.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await openGpus(id)).toBe(1);
    expect(await freeGpus(offer)).toBe(free0 - 1);
  });
});


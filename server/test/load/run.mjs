// Нагрузочные сценарии (autocannon). Щадящие: не больше 20 соединений и 20 секунд на сценарий.
//   BASE_URL=http://localhost:3016 LOAD_PASSWORD=... node test/load/run.mjs
// Переменные:
//   BASE_URL      адрес сервера (по умолчанию http://localhost:3001)
//   CONNECTIONS   число соединений (по умолчанию 10, максимум 20)
//   DURATION      длительность одного сценария, с (по умолчанию 15, максимум 20)
//   LOAD_EMAIL    пользователь для сценариев с входом (по умолчанию demo@gpu-rent.example)
//   LOAD_PASSWORD пароль этого пользователя; не задан — сценарии с входом пропускаются
//   LOAD_NAME     имя прогона для файла результатов (по умолчанию local или host из BASE_URL)
//   LOAD_NOTE     режим запуска сервера одной строкой, попадает в файл результатов
import autocannon from 'autocannon';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CONNECTIONS = 20;
const MAX_DURATION = 20;

const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const origin = new URL(baseUrl).origin;
const connections = clamp(Number(process.env.CONNECTIONS ?? 10), 1, MAX_CONNECTIONS);
const duration = clamp(Number(process.env.DURATION ?? 15), 1, MAX_DURATION);
const email = process.env.LOAD_EMAIL ?? 'demo@gpu-rent.example';
const password = process.env.LOAD_PASSWORD;

const here = dirname(fileURLToPath(import.meta.url));
const lines = [];

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.round(n), min), max);
}

function out(line = '') {
  console.log(line);
  lines.push(line);
}

// Вход: cookie сессии берём из Set-Cookie ответа, дальше подставляем в заголовок сценариев
async function login() {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', origin },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`вход не удался: HTTP ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('сервер не выдал cookie сессии');
  return cookie;
}

// Одиночные запросы до прогона: время первого ответа и заголовки кэша (autocannon заголовков ответа не показывает)
async function probe(path, headers) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const res = await fetch(baseUrl + path, { headers });
    await res.arrayBuffer();
    samples.push({
      status: res.status,
      ms: performance.now() - t0,
      cacheControl: res.headers.get('cache-control'),
      vercelCache: res.headers.get('x-vercel-cache'),
    });
  }
  return samples;
}

function fmt(n) {
  return Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

async function runScenario(title, path, headers) {
  out(`## ${title}  (GET ${path})`);
  const probes = await probe(path, headers);
  out(
    `первые запросы: ${probes.map((p) => `${p.status} за ${fmt(p.ms)} мс`).join(', ')}; ` +
      `Cache-Control: ${probes[0].cacheControl ?? '-'}; x-vercel-cache: ${probes.map((p) => p.vercelCache ?? '-').join('/')}`,
  );
  const r = await autocannon({ url: baseUrl + path, connections, duration, headers });
  const total = r.requests.total;
  out(`запросов: ${fmt(total)} (2xx: ${fmt(r['2xx'])}, не 2xx: ${fmt(r.non2xx)}), ошибок: ${r.errors}, таймаутов: ${r.timeouts}`);
  out(`запросов в секунду: среднее ${fmt(r.requests.average)}, минимум ${fmt(r.requests.min)}, максимум ${fmt(r.requests.max)}`);
  // В autocannon нет p95, есть p97.5: подписываем как есть, не подменяя
  out(
    `задержка, мс: среднее ${fmt(r.latency.average)}, p50 ${fmt(r.latency.p50)}, p90 ${fmt(r.latency.p90)}, ` +
      `p97.5 ${fmt(r.latency.p97_5)}, p99 ${fmt(r.latency.p99)}, максимум ${fmt(r.latency.max)}`,
  );
  out(`трафик: ${fmt(r.throughput.average / 1024)} КиБ/с в среднем`);
  out();
}

async function main() {
  if (connections !== Number(process.env.CONNECTIONS ?? 10) || duration !== Number(process.env.DURATION ?? 15)) {
    console.log(`Параметры ограничены: соединений не больше ${MAX_CONNECTIONS}, длительность не больше ${MAX_DURATION} с`);
  }

  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));
  const started = new Date();
  const name = process.env.LOAD_NAME ?? (['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname) ? 'local' : new URL(baseUrl).hostname);

  out('Нагрузочный прогон GPU Rent (autocannon)');
  out(`дата: ${started.toISOString()}`);
  out(`адрес: ${baseUrl}`);
  out(`версия приложения: ${health.version ?? '?'} (server/package.json ${pkg.version})`);
  out(`где запущен клиент нагрузки: ${os.platform()} ${os.arch()}, ${os.cpus().length} ядер (${os.cpus()[0]?.model ?? '?'}), Node ${process.version}`);
  out(`режим сервера: ${process.env.LOAD_NOTE ?? 'не указан'}`);
  out(`соединений: ${connections}, длительность сценария: ${duration} с`);
  out();

  await runScenario('Публичный каталог GPU', '/api/catalog/gpus');
  await runScenario('Проверка работоспособности (без БД)', '/api/health');

  if (!password) {
    out('Сценарии с входом пропущены: не задан LOAD_PASSWORD.');
  } else {
    const cookie = await login();
    out(`вход выполнен как ${email}`);
    out();
    await runScenario('Текущий пользователь', '/api/auth/me', { cookie });
    await runScenario('Список инстансов (с начислением при обращении)', '/api/instances', { cookie });
  }

  out('Это проверка работоспособности под небольшой нагрузкой, а не доказательство целевых показателей:');
  out('требование NFR-01 (p95 < 300 мс при 1000 запросов в секунду) на таком числе соединений не проверяется.');

  const dir = join(here, 'results');
  mkdirSync(dir, { recursive: true });
  const stamp = started.toISOString().slice(0, 16).replace(':', '');
  const file = join(dir, `${name}-${stamp}.txt`);
  writeFileSync(file, lines.join('\n') + '\n');
  console.log(`Результаты записаны в ${file}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

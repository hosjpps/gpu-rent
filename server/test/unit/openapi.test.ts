import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApp } from '../../src/app';

const specText = readFileSync(join(__dirname, '..', '..', 'openapi.yaml'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spec: any = parse(specText);

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// createApp ничего не открывает при создании (соединение с БД — только по первому запросу), поэтому окружение вымышленное.
const app = createApp({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://nobody@localhost:1/none',
  ENC_KEY: 'unit-test-enc-key-0123456789',
  WEBHOOK_SECRET: 'unit-test-webhook-secret-0123',
} as NodeJS.ProcessEnv);

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  regexp: RegExp;
}

/** Все маршруты, смонтированные в приложении: «GET /api/auth/me». Вложенные роутеры раскрываются по префиксу монтирования. */
function mountedRoutes(): string[] {
  const out: string[] = [];
  const walk = (stack: Layer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) out.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      } else if (layer.handle?.stack) {
        // у app.use('/api/auth', router) регулярка вида ^\/api\/auth\/?(?=\/|$): из неё достаём сам путь
        const mount = layer.regexp.source.replace(/^\^/, '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  // _router у Express 4 не входит в типы
  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, '');
  return out;
}

/** Все операции документа в том же виде: «GET /api/auth/me» (путь с {id} приведён к :id). */
function documentedRoutes(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
    for (const method of METHODS) {
      if (item[method]) out.push(`${method.toUpperCase()} /api${path.replace(/\{(\w+)\}/g, ':$1')}`);
    }
  }
  return out;
}

describe('openapi.yaml: структура', () => {
  it('это OpenAPI 3.1 с описанием, серверами и путями', () => {
    expect(String(spec.openapi)).toMatch(/^3\.1\.\d+$/);
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.servers[0].url).toBe('/api');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(30);
  });

  it('все $ref указывают на существующие элементы документа', () => {
    const refs = [...specText.matchAll(/\$ref: '(#\/[^']+)'/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(100);
    const missing = refs.filter((ref) => {
      let node: unknown = spec;
      for (const part of ref.slice(2).split('/')) node = (node as Record<string, unknown> | undefined)?.[part];
      return node === undefined;
    });
    expect([...new Set(missing)]).toEqual([]);
  });

  it('у каждой операции есть уникальный operationId, тег, явная безопасность и успешный ответ', () => {
    const ids = new Set<string>();
    const tags = new Set<string>(spec.tags.map((t: { name: string }) => t.name));
    const schemes = new Set(Object.keys(spec.components.securitySchemes));
    const problems: string[] = [];
    for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const where = `${method.toUpperCase()} ${path}`;
        if (!op.operationId || ids.has(op.operationId)) problems.push(`${where}: operationId пуст или повторён`);
        ids.add(op.operationId);
        if (!op.summary) problems.push(`${where}: нет summary`);
        if (!op.tags?.length || !op.tags.every((t: string) => tags.has(t))) problems.push(`${where}: тег не из списка tags`);
        if (!Array.isArray(op.security)) problems.push(`${where}: security не указан явно (публичная — security: [])`);
        for (const req of op.security ?? []) {
          for (const name of Object.keys(req)) if (!schemes.has(name)) problems.push(`${where}: неизвестная схема безопасности ${name}`);
        }
        if (!Object.keys(op.responses ?? {}).some((code) => /^2\d\d$/.test(code))) problems.push(`${where}: нет успешного ответа`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('каждый параметр пути {name} объявлен у операции', () => {
    const problems: string[] = [];
    for (const [path, item] of Object.entries<Record<string, any>>(spec.paths)) {
      const names = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const method of METHODS) {
        const op = item[method];
        if (!op) continue;
        const declared = (op.parameters ?? []).map((p: { $ref?: string; name?: string; in?: string }) => {
          const resolved = p.$ref ? spec.components.parameters[p.$ref.split('/').pop()!] : p;
          return resolved.in === 'path' ? resolved.name : undefined;
        });
        for (const n of names) if (!declared.includes(n)) problems.push(`${method.toUpperCase()} ${path}: нет параметра пути ${n}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('openapi.yaml и маршруты приложения', () => {
  const mounted = mountedRoutes().sort();
  const documented = documentedRoutes().sort();

  it('нашлось достаточно смонтированных маршрутов (проверка самого обхода)', () => {
    expect(mounted.length).toBeGreaterThan(40);
    expect(mounted).toContain('POST /api/instances/:id/stop');
  });

  it('каждый маршрут приложения описан в документе', () => {
    expect(mounted.filter((r) => !documented.includes(r))).toEqual([]);
  });

  it('каждая операция документа реализована в приложении', () => {
    expect(documented.filter((r) => !mounted.includes(r))).toEqual([]);
  });
});

describe('GET /api/openapi.yaml и GET /api/docs', () => {
  it('отдаёт тот же файл с публичным кэшем', async () => {
    const res = await request(app).get('/api/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/yaml/);
    expect(res.headers['cache-control']).toBe('public, s-maxage=30, stale-while-revalidate=60');
    expect(res.text).toBe(specText);
    expect(parse(res.text).openapi).toBe(spec.openapi);
  });

  it('страница документации разрешает только CDN и один inline-скрипт по хэшу', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('public, s-maxage=30, stale-while-revalidate=60');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src https:\/\/cdn\.jsdelivr\.net 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    // хэш в политике — именно хэш того inline-скрипта, что лежит на странице, иначе браузер его не выполнит
    const inline = /<script>([\s\S]*?)<\/script>/.exec(res.text)![1]!;
    expect(csp).toContain(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`);
    // внешние ресурсы — только с CDN и с проверкой целостности (SRI)
    const external = [...res.text.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]!);
    expect(external.length).toBe(2);
    for (const url of external) expect(url.startsWith('https://cdn.jsdelivr.net/npm/swagger-ui-dist@')).toBe(true);
    expect(res.text.match(/integrity="sha384-/g)?.length).toBe(2);
  });

  it('остальной API по-прежнему отдаёт строгую политику без CDN', async () => {
    const res = await request(app).get('/api/health');
    expect(String(res.headers['content-security-policy'])).not.toContain('cdn.jsdelivr.net');
  });
});

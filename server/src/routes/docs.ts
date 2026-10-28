import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import type { Config } from '../config';
import { PUBLIC_CACHE, wrap } from '../http';

// Swagger UI берётся с CDN: так в репозитории нет лишних 1,5 МБ, а версия закреплена и проверяется по SRI.
const CDN = 'https://cdn.jsdelivr.net';
const UI_VERSION = '5.17.14';
const UI_CSS_SRI = 'sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn';
const UI_JS_SRI = 'sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep';

// Запросы «Try it out» идут с этой же страницы: заголовок защиты от CSRF добавляется сам, чтобы не вписывать его вручную.
const INIT_SCRIPT = `
window.ui = SwaggerUIBundle({
  url: '/api/openapi.yaml',
  dom_id: '#swagger-ui',
  deepLinking: true,
  persistAuthorization: false,
  requestInterceptor: function (req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') req.headers['X-Requested-With'] = 'fetch';
    return req;
  }
});
`;

// Страница статична и кэшируется CDN, поэтому inline-скрипт разрешён по хэшу, а не по nonce (nonce в кэше повторялся бы).
const SCRIPT_HASH = `'sha256-${createHash('sha256').update(INIT_SCRIPT).digest('base64')}'`;

const DOCS_CSP = [
  "default-src 'none'",
  `script-src ${CDN} ${SCRIPT_HASH}`,
  `style-src ${CDN}`,
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const DOCS_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GPU Rent API</title>
<link rel="stylesheet" href="${CDN}/npm/swagger-ui-dist@${UI_VERSION}/swagger-ui.css" integrity="${UI_CSS_SRI}" crossorigin="anonymous">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${CDN}/npm/swagger-ui-dist@${UI_VERSION}/swagger-ui-bundle.js" integrity="${UI_JS_SRI}" crossorigin="anonymous"></script>
<script>${INIT_SCRIPT}</script>
</body>
</html>
`;

// Файл лежит в server/openapi.yaml, то есть на два уровня выше этого модуля и в src/, и в собранном dist/.
// На Vercel он попадает в функцию через includeFiles (vercel.json), а путь с __dirname видит и сборщик зависимостей.
const SPEC_PATHS = [join(__dirname, '..', '..', 'openapi.yaml'), join(process.cwd(), 'openapi.yaml'), join(process.cwd(), 'server', 'openapi.yaml')];

let spec: string | undefined;
function loadSpec(): string {
  if (spec === undefined) {
    const path = SPEC_PATHS.find((p) => existsSync(p));
    if (!path) throw new Error(`openapi.yaml не найден, искали: ${SPEC_PATHS.join(', ')}`);
    spec = readFileSync(path, 'utf8');
  }
  return spec;
}

export function docsRoutes(_config: Config): Router {
  const router = Router();

  router.get(
    '/openapi.yaml',
    wrap(async (_req, res) => {
      res.set('Cache-Control', PUBLIC_CACHE);
      res.type('application/yaml; charset=utf-8').send(loadSpec());
    }),
  );

  // Общая политика API (default-src 'none') страницу Swagger UI не пустила бы; здесь она заменяется своей,
  // которая разрешает только этот CDN и один inline-скрипт по хэшу.
  router.get('/docs', (_req, res) => {
    res.set('Cache-Control', PUBLIC_CACHE);
    res.set('Content-Security-Policy', DOCS_CSP);
    res.type('html').send(DOCS_HTML);
  });

  return router;
}

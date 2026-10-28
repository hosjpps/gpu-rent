// Размеры файлов сборки: исходный, gzip и brotli (CDN Vercel отдаёт brotli/gzip сам).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist', import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const kb = (n) => (n / 1024).toFixed(1).padStart(8);
const rows = walk(dist)
  .filter((f) => /\.(js|css|html|svg)$/.test(f))
  .map((f) => {
    const data = readFileSync(f);
    return {
      file: relative(dist, f),
      raw: data.length,
      gzip: gzipSync(data, { level: 9 }).length,
      br: brotliCompressSync(data).length,
    };
  })
  .sort((a, b) => b.raw - a.raw);

console.log('\nРазмеры сборки (КБ)');
console.log('файл'.padEnd(36), '   исходный      gzip    brotli');
for (const r of rows) {
  console.log(r.file.padEnd(36), kb(r.raw), 'KB', kb(r.gzip), 'KB', kb(r.br), 'KB');
}
const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
console.log('-'.repeat(70));
console.log('итого'.padEnd(36), kb(sum('raw')), 'KB', kb(sum('gzip')), 'KB', kb(sum('br')), 'KB');

// Что браузер грузит на первом экране: только чанки, подключённые из index.html
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const first = rows.filter((r) => initial.includes(r.file));
console.log(
  `\nПервая загрузка (${first.length} файла): ${kb(first.reduce((s, r) => s + r.gzip, 0)).trim()} KB gzip, ` +
    `${kb(first.reduce((s, r) => s + r.br, 0)).trim()} KB brotli`,
);

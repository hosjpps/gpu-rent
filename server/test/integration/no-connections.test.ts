import { describe, expect, it } from 'vitest';
import { isPoolCreated } from '../../src/db';
import { createApp } from '../../src/app';
import { bare, makeApp, testEnv } from './helpers';

// Файл отдельный: пул на уровне модуля, а vitest изолирует модули по файлам, поэтому начальное состояние чистое.
describe('импорт и создание приложения не открывают соединений', () => {
  it('сам импорт src/app и src/db: пула нет', () => {
    expect(isPoolCreated()).toBe(false);
  });

  it('createApp() читает окружение, но пул не создаёт', () => {
    const app = createApp(testEnv());
    expect(typeof app).toBe('function');
    expect(isPoolCreated()).toBe(false);
  });

  it('неверное окружение даёт понятную ошибку при создании приложения, а не при импорте', () => {
    expect(() => createApp({})).toThrow(/Неверная конфигурация окружения/);
    expect(isPoolCreated()).toBe(false);
  });

  it('точка входа Vercel api/index.ts при импорте создаёт приложение, но не подключается к БД', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, testEnv());
    try {
      const entry = '../../../api/index.ts'; // вне server/: путь в переменной, чтобы tsc не втягивал файл в проект
      const mod = (await import(/* @vite-ignore */ entry)) as { default: unknown };
      expect(typeof mod.default).toBe('function');
      expect(isPoolCreated()).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('/api/health и несуществующий адрес БД не трогают', async () => {
    const app = makeApp();
    expect((await bare(app).get('/api/health')).status).toBe(200);
    expect((await bare(app).get('/api/nothing')).status).toBe(404);
    expect(isPoolCreated()).toBe(false);
  });

  it('первый запрос, которому нужна БД, создаёт пул ровно один раз', async () => {
    const app = makeApp();
    expect((await bare(app).get('/api/catalog/gpus')).status).toBe(200);
    expect(isPoolCreated()).toBe(true);
    const { closePool } = await import('../../src/db');
    await closePool();
    expect(isPoolCreated()).toBe(false);
  });
});

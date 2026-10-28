import { userInfo } from 'node:os';
import { defineConfig } from 'vitest/config';

// Тестовая БД и пароли ниже совпадают со значениями по умолчанию в db/scripts/test_server_db.sh.
const dbName = process.env.TEST_DB_NAME ?? 'gpu_rent_test';
const host = process.env.PGHOST ?? 'localhost';
const port = process.env.PGPORT ?? '5432';
const webPassword = process.env.GPU_RENT_WEB_PASSWORD ?? 'webdev12345';
const superUser = process.env.PGUSER ?? userInfo().username;

export default defineConfig({
  test: {
    projects: [
      {
        // Чистые функции и middleware без базы данных
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Приложение целиком против БД gpu_rent_test: globalSetup пересоздаёт её (миграции, демо-сид, роль gpu_rent_web).
        // singleFork: файлы идут по одному в одном процессе, потому что тесты делят одну БД. Приложение подключается под
        // настоящей LOGIN-ролью gpu_rent_web.
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: {
            NODE_ENV: 'test',
            // приложение: LOGIN-роль без прав владельца
            TEST_DATABASE_URL: `postgres://gpu_rent_web:${encodeURIComponent(webPassword)}@${host}:${port}/${dbName}`,
            // подготовка данных и проверки "изнутри": суперпользователь кластера (обходит RLS)
            TEST_OWNER_URL: `postgres://${encodeURIComponent(superUser)}@${host}:${port}/${dbName}`,
            TEST_DEMO_PASSWORD: process.env.DEMO_PASSWORD ?? 'demo-test-12345',
            TEST_ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? 'admin-test-12345',
          },
        },
      },
    ],
  },
});

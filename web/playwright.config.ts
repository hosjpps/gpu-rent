import { defineConfig, devices } from '@playwright/test';

// Против чего гоняем тесты: локально это vite (5173), на проде/превью — E2E_BASE_URL.
// E2E_READONLY=1 оставляет только безопасные проверки без изменения данных (для production).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Сценарии зависят друг от друга по данным (один пользователь на весь прогон), поэтому по очереди
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Если нужной версии браузера нет и скачать её нельзя, можно указать свой Chromium
        launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH || undefined },
      },
    },
  ],
});

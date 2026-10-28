import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Учётные записи берём из окружения: в репозитории паролей нет
export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@gpu-rent.example',
  password: process.env.E2E_ADMIN_PASSWORD ?? '',
};
export const DEMO = {
  email: process.env.E2E_DEMO_EMAIL ?? 'demo@gpu-rent.example',
  password: process.env.E2E_DEMO_PASSWORD ?? '',
};

export const READONLY = process.env.E2E_READONLY === '1';

/** Новый уникальный пользователь для сценария */
export function newUser(prefix: string) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    fullName: `Тест ${prefix}`,
    email: `e2e-${prefix}-${id}@example.test`,
    // 8+ символов, буква и цифра
    password: `E2e-${id}-pass1`,
  };
}

export async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/instances/);
}

/**
 * Скриншот ключевого экрана для отчёта. Работает только при SCREENSHOTS=1,
 * по умолчанию кладёт файлы в docs/screenshots репозитория.
 * viewport: временный размер окна для снимка (после снимка размер возвращается), fullPage: страница целиком,
 * toasts: оставить всплывающие уведомления в кадре (по умолчанию скрыты, чтобы не закрывать содержимое).
 */
export async function shot(
  page: Page,
  name: string,
  opts: { fullPage?: boolean; toasts?: boolean; viewport?: { width: number; height: number } } = {},
) {
  if (process.env.SCREENSHOTS !== '1') return;
  const dir = process.env.SCREENSHOTS_DIR ?? fileURLToPath(new URL('../../docs/screenshots', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const previous = page.viewportSize();
  if (opts.viewport) await page.setViewportSize(opts.viewport);
  // через style элемента, а не <style>: на странице документации строгая CSP запрещает встроенные стили
  const setToasts = (display: string) =>
    page.evaluate((d) => document.querySelectorAll<HTMLElement>('.toasts').forEach((el) => (el.style.display = d)), display);
  if (!opts.toasts) await setToasts('none');
  // дать графикам, шрифтам и подсказкам дорисоваться
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: opts.fullPage ?? false });
  if (!opts.toasts) await setToasts('');
  if (opts.viewport && previous) await page.setViewportSize(previous);
}

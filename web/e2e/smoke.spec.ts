// Безопасные проверки без изменения данных: подходят и для production (E2E_READONLY=1).
import { expect, test } from '@playwright/test';
import { DEMO, login, shot } from './helpers';

test.describe('Публичная часть', () => {
  test('здоровье API отвечает', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('каталог GPU виден без входа', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Каталог' })).toBeVisible();
    await expect(page.getByTestId('gpu-table').first()).toBeVisible();
    // в таблице есть цены в рублях и кнопки запуска
    await expect(page.getByTestId('gpu-table').first().getByRole('button', { name: /Запустить/ }).first()).toBeVisible();
    await shot(page, '01-catalog', { viewport: { width: 1280, height: 960 } });
  });

  test('вкладка «Шаблоны» показывает публичные шаблоны', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Шаблоны' }).click();
    await expect(page.getByText('PyTorch').first()).toBeVisible();
  });

  test('защищённые страницы ведут на вход', async ({ page }) => {
    await page.goto('/instances');
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/login/);
  });

  test('на экране 360 px нет горизонтальной прокрутки', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ['/', '/login', '/register']) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `горизонтальный скролл на ${path}`).toBeLessThanOrEqual(0);
    }
    await page.goto('/');
    await expect(page.getByTestId('gpu-table').first()).toBeVisible();
    await shot(page, '09-catalog-mobile', { viewport: { width: 390, height: 844 } });
  });

  test('документация API: Swagger UI показывает операции', async ({ page }) => {
    await page.goto('/api/docs');
    await expect(page.locator('.swagger-ui .info .title')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.swagger-ui .opblock-tag').first()).toBeVisible();
    const spec = await page.request.get('/api/openapi.yaml');
    expect(spec.ok()).toBe(true);
    // прокручиваем к разделу «Инстансы», чтобы в кадре были операции, а не только вступление (разделы раскрыты сразу)
    const tag = page.locator('.swagger-ui .opblock-tag[data-tag="Инстансы"]');
    await expect(page.locator('.swagger-ui .opblock').first()).toBeVisible();
    await tag.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -16));
    await shot(page, '10-swagger', { viewport: { width: 1280, height: 900 } });
  });
});

test.describe('Вход демо-пользователя', () => {
  test.skip(!DEMO.password, 'не задан E2E_DEMO_PASSWORD');

  test('неверный пароль даёт понятную ошибку', async ({ page }) => {
    await page.goto('/login');
    await shot(page, '00-login');
    await page.getByLabel('Email').fill(DEMO.email);
    await page.getByLabel('Пароль').fill('неверный-пароль-1');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('вход, просмотр разделов и выход', async ({ page }) => {
    await login(page, DEMO.email, DEMO.password);
    await expect(page.getByRole('heading', { name: 'Мои инстансы' })).toBeVisible();
    await shot(page, '03-instances');
    await shot(page, '03-instances-mobile', { viewport: { width: 390, height: 844 } });

    await page.getByRole('link', { name: 'Баланс', exact: true }).click();
    await expect(page.getByTestId('balance')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'История операций' })).toBeVisible();
    await shot(page, '05-billing');

    await page.getByRole('link', { name: 'Тома' }).click();
    await expect(page.getByRole('heading', { name: 'Сетевые тома' })).toBeVisible();

    await page.getByRole('link', { name: 'Настройки' }).click();
    await expect(page.getByRole('heading', { name: 'SSH-ключи' })).toBeVisible();

    // клиент не видит админку и не попадает в неё по прямой ссылке
    await expect(page.getByRole('link', { name: 'Админка' })).toHaveCount(0);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/\/admin/);

    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/instances');
    await expect(page).toHaveURL(/\/login/);
  });
});

// Сценарии администратора: смена цены и блокировка пользователя. Изменяют данные (только не production).
import { expect, test } from '@playwright/test';
import { ADMIN, login, newUser, READONLY, shot } from './helpers';

test.skip(READONLY, 'E2E_READONLY=1: сценарии изменяют данные');
test.skip(!ADMIN.password, 'не задан E2E_ADMIN_PASSWORD');

test.describe.serial('Администратор', () => {
  test('дашборд и защита маршрутов', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await page.getByRole('link', { name: 'Админка' }).click();
    await expect(page.getByRole('heading', { name: 'Администрирование' })).toBeVisible();
    await expect(page.getByTestId('revenue-total')).toBeVisible();
    await shot(page, '07-admin-dashboard', { viewport: { width: 1280, height: 1180 } });

    await page.getByRole('link', { name: 'Инфраструктура' }).click();
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.locator('details.node summary').first().click();
    await shot(page, '08-admin-infrastructure');

    await page.getByRole('link', { name: 'Журнал аудита' }).click();
    await expect(page.getByTestId('audit-table')).toBeVisible();
  });

  test('смена цены: новая цена появляется в истории и в каталоге', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await page.goto('/admin/prices');

    const form = page.locator('form.price-form');
    const dc = await form.getByLabel('Дата-центр').inputValue();
    const model = await form.getByLabel('Модель GPU').inputValue();
    await form.getByLabel('Тариф').selectOption('on_demand');
    // прежняя цена нужна, чтобы вернуть её в конце и не портить каталог для остальных сценариев
    const current = page
      .getByTestId('prices-table')
      .locator('tbody tr')
      .filter({ hasText: dc })
      .filter({ hasText: model })
      .filter({ hasText: 'Обычный' })
      .filter({ hasText: 'действует' })
      .first();
    const oldPrice = (await current.locator('td').nth(3).innerText()).replace(/[^\d,]/g, '').replace(',', '.');
    // новая цена на 10% выше прежней, целая, чтобы в таблице она выглядела как «NNN,00»
    const newPrice = String(Math.round(Number(oldPrice) * 1.1));
    await form.getByLabel('Цена за GPU в час, ₽').fill(newPrice);
    await form.getByRole('button', { name: 'Установить цену' }).click();
    await expect(page.getByText('Новая цена действует')).toBeVisible();

    // в таблице действующих цен: строка этого ДЦ и модели с новой ценой
    const active = page
      .getByTestId('prices-table')
      .locator('tbody tr')
      .filter({ hasText: dc })
      .filter({ hasText: model })
      .filter({ hasText: 'действует' })
      .filter({ hasText: new RegExp(`${newPrice}[,.]00`) });
    await expect(active.first()).toBeVisible();
    await shot(page, '07-admin-prices');

    // публичный каталог показывает новую цену (после обновления кэша)
    await page.goto('/');
    await expect(page.getByTestId('gpu-table').first()).toContainText(new RegExp(`${newPrice}[,.]00`));

    // возвращаем прежнюю цену
    await page.goto('/admin/prices');
    await form.getByLabel('Тариф').selectOption('on_demand');
    await form.getByLabel('Цена за GPU в час, ₽').fill(oldPrice);
    await form.getByRole('button', { name: 'Установить цену' }).click();
    await expect(page.getByText('Новая цена действует')).toBeVisible();
  });

  test('блокировка пользователя', async ({ page, browser }) => {
    // жертва: новый клиент в отдельном контексте браузера
    const victim = newUser('victim');
    const vctx = await browser.newContext();
    const vpage = await vctx.newPage();
    await vpage.goto('/register');
    await vpage.getByLabel('Имя').fill(victim.fullName);
    await vpage.getByLabel('Email').fill(victim.email);
    await vpage.getByLabel('Пароль', { exact: true }).fill(victim.password);
    await vpage.getByLabel('Повторите пароль').fill(victim.password);
    await vpage.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(vpage).toHaveURL(/\/settings/);

    await login(page, ADMIN.email, ADMIN.password);
    await page.goto('/admin/users');
    await page.getByPlaceholder('email или имя').fill(victim.email);
    const row = page.locator(`tr[data-email="${victim.email}"]`);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Заблокировать' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Заблокировать', exact: true }).click();
    await expect(row.getByText('Заблокирован')).toBeVisible();

    // действие попало в журнал аудита
    await page.goto('/admin/audit');
    await expect(page.getByTestId('audit-table')).toContainText('user.status_changed');

    // у заблокированного пользователя в интерфейсе появляется предупреждение
    await vpage.reload();
    await expect(vpage.getByText(/Аккаунт заблокирован/)).toBeVisible();

    // обратно: разблокировка
    await page.goto('/admin/users');
    await page.getByPlaceholder('email или имя').fill(victim.email);
    await row.getByRole('button', { name: 'Разблокировать' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Разблокировать', exact: true }).click();
    await expect(row.getByText('Активен')).toBeVisible();
    await vctx.close();
  });
});

// Сквозной сценарий клиента: регистрация -> подтверждение email -> пополнение -> запуск -> остановка -> история.
// Изменяет данные, поэтому запускается только на локальной БД или отдельной ветке БД (не на production).
import { expect, test, type Page } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import { newUser, READONLY, shot } from './helpers';

test.skip(READONLY, 'E2E_READONLY=1: сценарий изменяет данные');

const user = newUser('client');
const instanceName = `e2e-${Date.now().toString(36)}`;
let page: Page;

// Настоящий публичный ключ ed25519 в формате authorized_keys: имя алгоритма и 32 байта ключа в base64
function newSshPublicKey(): string {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x as string, 'base64url');
  const name = Buffer.from('ssh-ed25519');
  const field = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return `ssh-ed25519 ${Buffer.concat([field(name), field(raw)]).toString('base64')} e2e@example.test`;
}

test.describe.serial('Клиент: от регистрации до истории операций', () => {
  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext()).newPage();
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test('регистрация: клиентская валидация и успешный вход', async () => {
    await page.goto('/register');
    await shot(page, '00-register');

    // пустая форма не уходит на сервер, а показывает ошибки у полей
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.getByText('Введите email')).toBeVisible();
    await expect(page).toHaveURL(/\/register/);

    await page.getByLabel('Имя').fill(user.fullName);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Пароль', { exact: true }).fill(user.password);
    await page.getByLabel('Повторите пароль').fill(`${user.password}x`);
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.getByText('Пароли не совпадают')).toBeVisible();

    await page.getByLabel('Повторите пароль').fill(user.password);
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByText(user.email)).toBeVisible();
  });

  test('подтверждение email (демо-ссылка)', async () => {
    const confirm = page.getByRole('button', { name: 'Подтвердить (демо)' });
    if (!(await confirm.isVisible())) {
      await page.getByRole('button', { name: 'Получить ссылку подтверждения' }).click();
    }
    await confirm.click();
    await expect(page.getByText('подтверждён', { exact: true })).toBeVisible();
    await expect(page.getByText('Email не подтверждён: запуск')).toHaveCount(0);
  });

  test('запуск без денег: ошибка 402 с понятным текстом', async () => {
    await page.goto('/');
    await page.getByTestId('gpu-table').first().getByRole('button', { name: /Запустить/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('hourly-cost')).not.toHaveText('—');
    // клиентская подсказка: стоимость часа выше баланса
    await expect(dialog.getByText(/Не хватает/)).toBeVisible();
    await dialog.getByLabel('Название').fill(instanceName);
    await dialog.getByRole('button', { name: 'Запустить', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(/средств|баланс/i);
    await expect(dialog.getByRole('link', { name: 'Пополнить баланс' }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('пополнение баланса через демо-оплату', async () => {
    await page.getByRole('link', { name: 'Баланс', exact: true }).click();
    await page.getByLabel('Сумма, ₽').fill('5000');
    await page.getByRole('button', { name: 'Пополнить', exact: true }).click();
    await expect(page.getByText(/Платёж № \d+/)).toBeVisible();
    await page.getByRole('button', { name: 'Оплатить (демо)' }).click();
    // баланс обновился без перезагрузки страницы
    await expect(page.getByTestId('balance')).toContainText('5');
    await expect(page.getByTestId('balance')).toContainText('000');
    await shot(page, '05-billing-after-topup', { toasts: true });
  });

  test('запуск инстанса из каталога', async () => {
    await page.goto('/');
    const launch = page.getByTestId('gpu-table').first().getByRole('button', { name: /Запустить/ });
    await launch.first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название').fill(instanceName);
    await expect(dialog.getByTestId('hourly-cost')).not.toHaveText('—');
    await shot(page, '02-launch-dialog', { viewport: { width: 1280, height: 960 } });
    await dialog.getByRole('button', { name: 'Запустить', exact: true }).click();
    await expect(page).toHaveURL(/\/instances/);
    const row = page.getByTestId('instance-row').filter({ hasText: instanceName });
    await expect(row).toBeVisible();
    await expect(row.getByText(/Работает|Запускается/)).toBeVisible();
    await shot(page, '03-instances-running', { toasts: true });
  });

  test('остановка с подтверждением', async () => {
    const row = page.getByTestId('instance-row').filter({ hasText: instanceName });
    await row.getByRole('button', { name: 'Стоп' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Остановить', exact: true }).click();
    await expect(row.getByText('Остановлен')).toBeVisible();
    // у остановленного появилась кнопка «Старт», у работающего её не было
    await expect(row.getByRole('button', { name: 'Старт' })).toBeVisible();
  });

  test('карточка инстанса', async () => {
    await page.getByRole('link', { name: instanceName }).click();
    await expect(page.getByRole('heading', { name: instanceName })).toBeVisible();
    await expect(page.getByText('Конфигурация')).toBeVisible();
    await shot(page, '04-instance-detail');
  });

  test('ключи: SSH-ключ и API-ключ добавляются и показываются в списке', async () => {
    await page.getByRole('link', { name: 'Настройки' }).click();
    await page.getByLabel('Название').first().fill('ноутбук');
    await page.getByLabel('Публичный ключ').fill(newSshPublicKey());
    await page.getByRole('button', { name: 'Добавить ключ' }).click();
    await expect(page.getByText('SHA256:')).toBeVisible();

    await page.getByLabel('Название').nth(1).fill('CI');
    await page.getByRole('button', { name: 'Создать ключ' }).click();
    // ключ показывается один раз, после подтверждения в списке остаётся только начало
    await expect(page.getByText('Скопируйте ключ сейчас')).toBeVisible();
    await expect(page.getByText(/gr_[A-Za-z0-9_-]{20,}/)).toBeVisible();
    await page.getByRole('button', { name: 'Я сохранил ключ' }).click();
    await expect(page.getByText('Скопируйте ключ сейчас')).toHaveCount(0);
    await expect(page.getByText('gr_…', { exact: false }).first()).toBeVisible();
    await shot(page, '06-settings-keys', { viewport: { width: 1280, height: 1600 } });
  });

  test('история операций содержит пополнение', async () => {
    await page.getByRole('link', { name: 'Баланс', exact: true }).click();
    const table = page.getByTestId('tx-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tr[data-type="topup"]').first()).toBeVisible();
    // таблица ниже графика расходов: отдельный кадр с прокруткой к истории
    await page.getByRole('heading', { name: 'История операций' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -80));
    await shot(page, '05-billing-history', { viewport: { width: 1280, height: 720 } });
  });

  test('удаление инстанса и выход', async () => {
    await page.getByRole('link', { name: 'Инстансы' }).click();
    const row = page.getByTestId('instance-row').filter({ hasText: instanceName });
    await row.getByRole('button', { name: 'Удалить' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
    // удалённые по умолчанию скрыты
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

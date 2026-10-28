# GPU Rent

Проект сервиса аренды облачных GPU-серверов (по мотивам RunPod, Vast.ai, Immers.cloud).
Клиент пополняет баланс, выбирает модель GPU в дата-центре, запускает инстанс из шаблона
(PyTorch, Jupyter, Stable Diffusion), подключается по SSH и платит посекундно. Администратор
управляет дата-центрами, нодами, GPU и ценами, смотрит загрузку и выручку.

## Отчёты по практическим занятиям

| № | Тема | PDF | Исходник |
|---|---|---|---|
| 1 | Введение в дисциплину. Организация командной работы и выбор проекта | [reports/pr1.pdf](reports/pr1.pdf) | [pr1-vvedenie.md](docs/reports/pr1-vvedenie.md) |
| 2 | Анализ требований и планирование разработки монолитного веб-приложения | [reports/pr2.pdf](reports/pr2.pdf) | [pr2-trebovaniya-i-plan.md](docs/reports/pr2-trebovaniya-i-plan.md) |
| 3 | Проектирование БД: концептуальная и логическая модель | [reports/pr3.pdf](reports/pr3.pdf) | [pr3-logicheskoe-proektirovanie-bd.md](docs/reports/pr3-logicheskoe-proektirovanie-bd.md) |
| 4 | Проектирование БД: физическая реализация, оптимизация и безопасность | [reports/pr4.pdf](reports/pr4.pdf) | [pr4-fizicheskaya-realizaciya-bd.md](docs/reports/pr4-fizicheskaya-realizaciya-bd.md) |

## Стек

База данных реализована; серверная и клиентская части запланированы.

- Сервер: Node.js 24 LTS, TypeScript, Express 4.
- Клиент: React 18 + Vite, собирается в статику, которую раздаёт Nginx (Express обслуживает только `/api`).
- СУБД: PostgreSQL 16 (`pgcrypto`, `btree_gist`, `citext`).
- Кэш и сессии: Redis 7. Деплой: Docker Compose, Nginx, TLS.

## Структура

```text
docs/reports/        отчёты П1–П4 (markdown-исходники)
docs/diagrams/src/   диаграммы PlantUML
docs/diagrams/png/   отрендеренные диаграммы
db/migrations/       SQL-миграции по порядку (NNNN_name.sql)
db/seed/             детерминированные тестовые данные (~1,2 млн записей потребления)
db/tests/            SQL-тесты и тест конкурентного доступа
db/bench/            сценарии EXPLAIN ANALYZE, результаты — в db/bench/results/
db/scripts/          reset.sh, test.sh, bench.sh
tools/               вспомогательные инструменты
reports/             готовые отчёты в PDF
```

## Запуск приложения локально

Нужны Node.js 20 или новее (на Vercel используется 24) и PostgreSQL 16 с суперпользователем кластера
(подключение — переменные `PGHOST`, `PGUSER`, как в разделе про БД). Пароли ниже — только для локальной разработки.

```bash
# 1. База gpu_rent_dev: миграции, компактный демо-сид (пользователи admin@gpu-rent.example и demo@gpu-rent.example)
PGDATABASE=gpu_rent_dev DEMO_PASSWORD=demo12345 ADMIN_PASSWORD=admin12345 bash db/scripts/reset.sh --demo
# 2. LOGIN-роль gpu_rent_web, под которой работает сервер (RLS и GRANT действуют, это не владелец схемы)
PGDATABASE=gpu_rent_dev GPU_RENT_WEB_PASSWORD=webdev12345 bash db/scripts/create_login_role.sh
# 3. Переменные окружения сервера и зависимости
cp .env.example server/.env
npm run install:all
# 4. Сервер (порт 3001) и Vite (порт 5173) вместе; Vite проксирует /api на сервер
npm run dev
```

Сайт открывается на `http://localhost:5173`, документация API — на `http://localhost:3001/api/docs`.
Файл `server/.env` в `.gitignore`; в нём `DEMO_MAIL=1` и `DEMO_PAYMENTS=1`: вместо письма и платёжного шлюза
ответ API содержит ссылку подтверждения email или оплаты.

## Тесты

```bash
bash db/scripts/test.sh                  # SQL-тесты БД и конкурентный тест (нужна БД из раздела «База данных»)
npm test                                 # сервер: unit и интеграционные (vitest + supertest)
npm run test:unit --prefix server        # только unit, без БД
npm run typecheck                        # типы сервера и клиента
npm --prefix web run build               # сборка клиента
```

Интеграционные тесты сервера сами пересоздают БД `gpu_rent_test` (`db/scripts/test_server_db.sh`: миграции,
демо-сид, роль `gpu_rent_web`) и работают под настоящей LOGIN-ролью, как приложение. Имя тестовой БД должно
оканчиваться на `_test`.

Нагрузочные сценарии (autocannon) щадящие: не больше 20 соединений и 20 секунд на сценарий.

```bash
cd server && npm run build && set -a && . ./.env && set +a && NODE_ENV=development PORT=3016 node dist/index.js &
cd server && BASE_URL=http://localhost:3016 LOAD_PASSWORD=demo12345 CONNECTIONS=10 DURATION=15 \
  LOAD_NOTE="собранный dist, NODE_ENV=development" npm run load
```

Результаты с условиями прогона пишутся в `server/test/load/results/<имя>-<дата>.txt`. `NODE_ENV=production`
по http не подходит: cookie сессии получает флаг Secure и в браузере или клиенте без https не сохраняется.
Без `LOAD_PASSWORD` сценарии с входом пропускаются.

E2E (Playwright) лежат в `web/e2e`; адрес проверяемого сайта — `E2E_BASE_URL`, пароли пользователей —
`E2E_DEMO_PASSWORD`, `E2E_ADMIN_PASSWORD`. Изменяющие сценарии запускают только против локального приложения
или отдельной тестовой БД; против production — `E2E_READONLY=1`.

```bash
npx --prefix web playwright install chromium   # один раз; свой браузер — переменная E2E_CHROMIUM_PATH
E2E_DEMO_PASSWORD=demo12345 E2E_ADMIN_PASSWORD=admin12345 npm --prefix web run e2e
npm --prefix web run e2e:screenshots           # то же, плюс снимки экранов в docs/screenshots (пароли — как выше)
```

Каждый прогон регистрирует двух новых пользователей, а лимит регистраций с одного IP по умолчанию — 10 в час. При частых
прогонах поднимите его только для локального сервера: `AUTH_REGISTER_IP_MAX=200 AUTH_LOGIN_IP_MAX=1000`.
Сервер на другом порту: `API_URL=http://localhost:3101 npm --prefix web run dev` направит прокси Vite туда.

### Непрерывная интеграция

В `.github/workflows`:

- `ci.yml` — на push в main и на pull request: SQL-тесты БД, типы и тесты сервера, типы и сборка клиента (Postgres 16 как service, Node 24);
- `billing-cron.yml` — каждые 30 минут вызывает `POST /api/internal/billing`; нужны `secrets.CRON_SECRET` и `vars.APP_URL`, без них шаг пропускается;
- `uptime.yml` — раз в час проверяет `/api/health` и `/api/health?deep=1`; нужен `vars.APP_URL`;
- `db-backup.yml` — раз в сутки `pg_dump` боевой БД с проверочным восстановлением в Postgres service; нужен `secrets.DATABASE_URL_DIRECT`. В артефакт (7 дней) дамп попадает только зашифрованным (`secrets.BACKUP_PASSPHRASE`): репозиторий публичный, артефакты видны любому вошедшему в GitHub.

## База данных

Нужен PostgreSQL 16 с расширениями `pgcrypto`, `btree_gist`, `citext` и пользователь с правами
суперпользователя кластера (скрипты создают роли `gpu_rent_owner`, `gpu_rent_app`,
`gpu_rent_analyst`). Параметры подключения — стандартные переменные `PGHOST`, `PGPORT`, `PGUSER`,
имя БД — `PGDATABASE` (по умолчанию `gpu_rent`).

```bash
bash db/scripts/reset.sh            # пересоздать БД: миграции + сид (около минуты)
bash db/scripts/reset.sh --no-seed  # только миграции
bash db/scripts/test.sh             # SQL-тесты, ненулевой код при падении
bash db/tests/concurrency.sh        # параллельные сессии: запуск инстансов, пополнение, биллинг
bash db/scripts/bench.sh            # сценарии EXPLAIN ANALYZE → db/bench/results/
```

Ключевые решения схемы:

- запрет двойного выделения GPU — `EXCLUDE USING gist (gpu_id WITH =, allocated_during WITH &&)`;
- история цен без пересечений периодов — `tstzrange` + `EXCLUDE`;
- журнал операций баланса неизменяем, `users.balance` — кэш суммы журнала, поддерживается триггером;
- `usage_records` секционирована по месяцам (BRIN по времени, partition pruning);
- изоляция клиентов — Row Level Security по контексту `app.user_id`;
- секреты окружения инстансов — `pgp_sym_encrypt`, ключ передаётся приложением и в БД не хранится.

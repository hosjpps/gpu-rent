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

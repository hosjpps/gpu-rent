#!/usr/bin/env bash
# Готовит БД gpu_rent_test для интеграционных тестов сервера (server/test/integration): пересоздаёт её с нуля,
# применяет миграции и компактный демо-сид, создаёт LOGIN-роль gpu_rent_web. Повторный запуск даёт то же состояние.
#   db/scripts/test_server_db.sh
# Его же вызывает globalSetup vitest. Нужен суперпользователь кластера (как у reset.sh). Пароли ниже — только для тестов;
# их можно переопределить переменными окружения DEMO_PASSWORD, ADMIN_PASSWORD, GPU_RENT_WEB_PASSWORD.
set -euo pipefail

# Имя БД задаётся здесь, а не берётся из PGDATABASE: скрипт удаляет базу, и dev-БД под руку попасть не должна.
export PGDATABASE="${TEST_DB_NAME:-gpu_rent_test}"
if [[ "$PGDATABASE" != *_test ]]; then
    echo "Ошибка: имя тестовой БД должно оканчиваться на _test (получено $PGDATABASE)" >&2
    exit 1
fi
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

export DEMO_PASSWORD="${DEMO_PASSWORD:-demo-test-12345}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin-test-12345}"
# Роль gpu_rent_web общая для всего кластера: пароль по умолчанию совпадает с локальной dev-БД, иначе запуск тестов
# сломал бы вход уже работающим локальным серверам.
export GPU_RENT_WEB_PASSWORD="${GPU_RENT_WEB_PASSWORD:-webdev12345}"

echo "== БД $PGDATABASE: пересоздание"
recreate_db "$PGDATABASE"
echo "== миграции"
apply_migrations "$PGDATABASE"
echo "== демо-сид"
psql_db -f "$DB_ROOT/seed/seed_demo.sql"
echo "== LOGIN-роль"
"$DB_ROOT/scripts/create_login_role.sh"
echo "== готово: $PGDATABASE"

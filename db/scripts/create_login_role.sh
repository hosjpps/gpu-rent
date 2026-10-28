#!/usr/bin/env bash
# Создаёт (или обновляет пароль) LOGIN-роль gpu_rent_web — член gpu_rent_app. Под ней работает веб-приложение:
# RLS и GRANT действуют, потому что это не владелец схемы и не суперпользователь.
#   GPU_RENT_WEB_PASSWORD=... db/scripts/create_login_role.sh
# Пароль берётся только из переменной окружения (psql читает её сам через \getenv), в аргументах процесса его нет.
# Текст CREATE/ALTER ROLE всё равно уходит на сервер: при log_statement = all пароль попал бы в журнал сервера.
# Роль создаётся SQL-командой, а не через консоль провайдера (на Neon консоль выдаёт роли neon_superuser).
# Подключение — стандартные PGHOST/PGPORT/PGUSER/PGDATABASE; пользователю нужно право CREATEROLE.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ -z "${GPU_RENT_WEB_PASSWORD:-}" ]]; then
    echo "Ошибка: задайте пароль роли в переменной окружения GPU_RENT_WEB_PASSWORD" >&2
    exit 1
fi
if [[ ${#GPU_RENT_WEB_PASSWORD} -lt 8 ]]; then
    echo "Ошибка: пароль GPU_RENT_WEB_PASSWORD короче 8 символов" >&2
    exit 1
fi

psql_db <<'SQL'
\getenv web_password GPU_RENT_WEB_PASSWORD
SELECT format('%s ROLE gpu_rent_web WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gpu_rent_web') THEN 'ALTER' ELSE 'CREATE' END,
              :'web_password') \gexec
GRANT gpu_rent_app TO gpu_rent_web;
-- Настройки роли действуют и через пулер Neon (параметры сессии оттуда не передаются): схема, потолок времени
-- запроса, потолок «зависшей» транзакции.
ALTER ROLE gpu_rent_web SET search_path = gpu_rent, pg_catalog;
ALTER ROLE gpu_rent_web SET statement_timeout = '15s';
ALTER ROLE gpu_rent_web SET idle_in_transaction_session_timeout = '30s';
SQL
echo "роль gpu_rent_web готова (член gpu_rent_app, БД $PGDATABASE)"

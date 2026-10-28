#!/usr/bin/env bash
# Создаёт (или обновляет пароль) LOGIN-роль gpu_rent_web — член gpu_rent_app. Под ней работает веб-приложение:
# RLS и GRANT действуют, потому что это не владелец схемы и не суперпользователь.
#   GPU_RENT_WEB_PASSWORD=... db/scripts/create_login_role.sh
# Пароль берётся только из переменной окружения (psql читает её сам через \getenv), в аргументах процесса его нет.
# Текст CREATE/ALTER ROLE всё равно уходит на сервер: при log_statement = all пароль попал бы в журнал сервера.
# Роль создаётся SQL-командой, а не через консоль провайдера (на Neon консоль выдаёт роли neon_superuser).
# Подключение — DATABASE_URL_DIRECT (прямой endpoint Neon) или стандартные PGHOST/PGPORT/PGUSER/PGDATABASE;
# пользователю нужно право CREATEROLE (на Neon его даёт роль-владелец проекта).
# GPU_RENT_WEB_ROLE — имя роли, по умолчанию gpu_rent_web (другое имя нужно только для проверок в общем кластере).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
use_database_url

web_role="${GPU_RENT_WEB_ROLE:-gpu_rent_web}"
if [[ ! "$web_role" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "Ошибка: недопустимое имя роли GPU_RENT_WEB_ROLE: $web_role" >&2
    exit 1
fi

if [[ -z "${GPU_RENT_WEB_PASSWORD:-}" ]]; then
    echo "Ошибка: задайте пароль роли в переменной окружения GPU_RENT_WEB_PASSWORD" >&2
    exit 1
fi
if [[ ${#GPU_RENT_WEB_PASSWORD} -lt 8 ]]; then
    echo "Ошибка: пароль GPU_RENT_WEB_PASSWORD короче 8 символов" >&2
    exit 1
fi

psql_db -v web_role="$web_role" <<'SQL'
\getenv web_password GPU_RENT_WEB_PASSWORD
SELECT format('%s ROLE %I WITH LOGIN PASSWORD %L CONNECTION LIMIT 20',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'web_role') THEN 'ALTER' ELSE 'CREATE' END,
              :'web_role', :'web_password') \gexec
GRANT gpu_rent_app TO :"web_role";
-- Привилегированные атрибуты (SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS) не задаём: у новой роли их нет по
-- умолчанию, а сменить их владелец без таких же атрибутов не может (PG16), ALTER ROLE упал бы на повторном запуске.
-- Проверяем итог ниже: так роль, заведённая вручную с лишними правами, не пройдёт молча.
-- Настройки роли действуют и через пулер Neon (параметры сессии оттуда не передаются): схема, потолок времени
-- запроса, потолок «зависшей» транзакции.
ALTER ROLE :"web_role" SET search_path = gpu_rent, pg_catalog;
ALTER ROLE :"web_role" SET statement_timeout = '15s';
ALTER ROLE :"web_role" SET idle_in_transaction_session_timeout = '30s';
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'web_role'
               AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS bad_attrs \gset
\if :bad_attrs
\echo Ошибка: у роли есть привилегированные атрибуты (SUPERUSER, CREATEDB, CREATEROLE, REPLICATION или BYPASSRLS): приложению они не нужны и обходят RLS
DO $$ BEGIN RAISE EXCEPTION 'privileged attributes on the application login role'; END $$;
\endif
SQL
echo "роль $web_role готова (член gpu_rent_app, БД $PGDATABASE)"

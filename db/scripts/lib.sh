#!/usr/bin/env bash
# Общие переменные и функции для reset.sh / test.sh / bench.sh. Подключается через source.
# Подключение берётся из стандартных переменных libpq (PGHOST, PGPORT, PGUSER, PGDATABASE);
# пользователь должен быть суперпользователем кластера (CREATE EXTENSION, создание ролей).

DB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGHOST="${PGHOST:-localhost}"
export PGDATABASE="${PGDATABASE:-gpu_rent}"
# NOTICE от RAISE в тестах нужны, а шум от IF NOT EXISTS — нет
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=notice}"

# psql без .psqlrc, с остановкой на первой ошибке
psql_db()    { psql -X -q -v ON_ERROR_STOP=1 -d "${DB:-$PGDATABASE}" "$@"; }
psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }

# Создаёт пустую БД $1 (пересоздаёт, если была).
recreate_db() {
    local db="$1"
    PGOPTIONS="-c client_min_messages=warning" \
        psql_admin -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\""
}

# Применяет все миграции из db/migrations по порядку имён к БД $1.
apply_migrations() {
    local db="$1" f
    for f in "$DB_ROOT"/migrations/*.sql; do
        echo "  migrate $(basename "$f")"
        PGOPTIONS="-c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$f" > /dev/null
    done
}

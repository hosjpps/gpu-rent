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

# Разбирает DATABASE_URL_DIRECT (postgres://пользователь:пароль@хост[:порт]/база?sslmode=...) в переменные libpq
# PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE. Так пароль не попадает в аргументы процесса (в отличие от
# psql "postgres://..."). Нужна для Neon, где подключение выдаётся одной строкой. Без DATABASE_URL_DIRECT ничего не меняет.
# Миграции и DDL идут только через прямой endpoint: пулер (хост с «-pooler») для них не подходит — отказываем сразу.
use_database_url() {
    local url="${DATABASE_URL_DIRECT:-}" re rest kv
    [[ -z "$url" ]] && return 0
    re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@(\[[^]]+\]|[^:/?]+)(:([0-9]+))?/([^?]*)(\?(.*))?$'
    if [[ ! "$url" =~ $re ]]; then
        echo "Ошибка: DATABASE_URL_DIRECT не разобран (ожидается postgres://пользователь:пароль@хост/база?sslmode=require)" >&2
        return 1
    fi
    # Часть значений приходит в процентной кодировке (спецсимволы в пароле)
    _pct_decode() { printf '%b' "${1//%/\\x}"; }
    export PGUSER PGHOST PGDATABASE
    PGUSER="$(_pct_decode "${BASH_REMATCH[2]}")"
    [[ -n "${BASH_REMATCH[4]}" ]] && export PGPASSWORD="$(_pct_decode "${BASH_REMATCH[4]}")"
    PGHOST="${BASH_REMATCH[5]}"
    [[ -n "${BASH_REMATCH[7]}" ]] && export PGPORT="${BASH_REMATCH[7]}"
    PGDATABASE="$(_pct_decode "${BASH_REMATCH[8]}")"
    rest="${BASH_REMATCH[10]}"
    while [[ -n "$rest" ]]; do
        kv="${rest%%&*}"
        [[ "$rest" == *"&"* ]] && rest="${rest#*&}" || rest=""
        case "$kv" in
            sslmode=*)         export PGSSLMODE="${kv#*=}" ;;
            channel_binding=*) export PGCHANNELBINDING="${kv#*=}" ;;
        esac
    done
    if [[ "$PGHOST" == *-pooler* ]]; then
        echo "Ошибка: в DATABASE_URL_DIRECT указан pooled-адрес ($PGHOST). Для миграций нужен прямой endpoint (без «-pooler»)." >&2
        return 1
    fi
}

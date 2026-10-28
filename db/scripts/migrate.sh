#!/usr/bin/env bash
# Применяет к существующей БД только ещё не применённые миграции db/migrations (по журналу gpu_rent.schema_migrations).
# Ничего не пересоздаёт и не удаляет, в отличие от reset.sh. Каждая миграция — отдельный вызов psql с ON_ERROR_STOP;
# сами файлы заключены в BEGIN ... COMMIT, поэтому упавшая миграция не оставляет половину изменений.
#   DATABASE_URL_DIRECT='postgres://владелец:пароль@ep-xxx.region.aws.neon.tech/neondb?sslmode=require' db/scripts/migrate.sh
# Подключение — DATABASE_URL_DIRECT (прямой endpoint Neon, не pooler) или стандартные PGHOST/PGPORT/PGUSER/PGDATABASE.
# Роль должна быть членом gpu_rent_owner с INHERIT и SET (на Neon это делает bootstrap_neon.sh) либо суперпользователем.
#   db/scripts/migrate.sh --dry-run   — только показать, что будет применено
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
use_database_url
# Параметры сессии не передаём через PGOPTIONS: на Neon их принимает только прямой endpoint, а SET работает везде
unset PGOPTIONS

dry_run=0
[[ "${1:-}" == "--dry-run" ]] && dry_run=1

echo "== БД ${PGDATABASE}, хост ${PGHOST}, роль $(psql_db -Atc 'SELECT current_user')"

# Мигратор должен уметь делать SET ROLE gpu_rent_owner; иначе миграция упадёт на середине с менее понятной ошибкой
check=$(psql_db -Atc "SELECT CASE
    WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN 'ok'
    WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gpu_rent_owner') THEN 'no_role'
    WHEN pg_has_role(current_user, 'gpu_rent_owner', 'USAGE') AND pg_has_role(current_user, 'gpu_rent_owner', 'SET') THEN 'ok'
    ELSE 'no_member' END")
if [[ "$check" != "ok" ]]; then
    echo "Ошибка: у роли нет прав мигратора ($check). Сначала выполните db/scripts/bootstrap_neon.sh под владельцем проекта." >&2
    exit 1
fi

# Журнал появляется только после 0001, до неё применённых миграций нет
if [[ "$(psql_db -Atc "SELECT to_regclass('gpu_rent.schema_migrations') IS NOT NULL")" == "t" ]]; then
    applied="$(psql_db -Atc 'SELECT version FROM gpu_rent.schema_migrations')"
else
    applied=""
fi

count=0
for f in "$DB_ROOT"/migrations/*.sql; do
    version="$(basename "$f" .sql)"
    if grep -qx "$version" <<<"$applied"; then
        continue
    fi
    if [[ $dry_run -eq 1 ]]; then
        echo "  будет применена: $version"
    else
        echo "  migrate $version"
        psql_db -c "SET client_min_messages = warning" -f "$f" > /dev/null
        # Файл обязан сам записать себя в журнал; иначе при следующем запуске он применился бы повторно
        if [[ "$(psql_db -Atc "SELECT EXISTS (SELECT 1 FROM gpu_rent.schema_migrations WHERE version = '$version')")" != "t" ]]; then
            echo "Ошибка: после $version в schema_migrations нет записи о ней" >&2
            exit 1
        fi
    fi
    count=$((count + 1))
done

if [[ $count -eq 0 ]]; then
    echo "== схема актуальна, применять нечего"
else
    echo "== применено миграций: $count"
fi

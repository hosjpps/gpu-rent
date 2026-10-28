#!/usr/bin/env bash
# Подготовка управляемого PostgreSQL без суперпользователя (Neon) к применению миграций. Выполняется один раз
# под ролью-владельцем проекта (на Neon — neondb_owner: CREATEROLE, CREATEDB, не суперпользователь).
#   DATABASE_URL_DIRECT='postgres://владелец:пароль@ep-xxx.region.aws.neon.tech/neondb?sslmode=require' \
#       db/scripts/bootstrap_neon.sh
# Подключение берётся из DATABASE_URL_DIRECT (прямой endpoint, не pooler) либо из стандартных PGHOST/PGUSER/PGDATABASE/...
#
# Что делает:
#   1. Создаёт NOLOGIN-роли gpu_rent_owner, gpu_rent_app, gpu_rent_analyst, если их нет. Миграция 0001 тоже умеет
#      их создавать, но членство ниже нужно до неё: без него 0001 упадёт на CREATE SCHEMA ... AUTHORIZATION.
#   2. Выдаёт мигратору (текущей роли) членство в gpu_rent_owner WITH INHERIT TRUE, SET TRUE. В PostgreSQL 16 создатель
#      роли получает только ADMIN OPTION, без INHERIT и SET: миграции выполняют SET LOCAL ROLE gpu_rent_owner и создают
#      объекты от его имени, поэтому без SET они не работают, а без INHERIT владелец-мигратор не получит права владельца.
# Членство в gpu_rent_app и gpu_rent_analyst не нужно: GRANT этих ролей другим и GRANT прав им доступны через ADMIN OPTION
# создателя и владение схемой. Суперпользовательских действий нет. Скрипт идемпотентен.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
use_database_url

if [[ "$(psql_db -Atc 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user')" == "t" ]]; then
    echo "Предупреждение: подключение от суперпользователя. На Neon его нет; для проверки совместимости запускайте под владельцем проекта." >&2
fi

psql_db <<'SQL'
-- Расширения из 0001 должны быть доступны: на Neon pgcrypto, btree_gist и citext разрешены (trusted)
DO $$
BEGIN
    IF (SELECT count(*) FROM pg_available_extensions WHERE name IN ('pgcrypto', 'btree_gist', 'citext')) < 3 THEN
        RAISE EXCEPTION 'на сервере нет расширений pgcrypto, btree_gist, citext';
    END IF;
END
$$;

SELECT format('CREATE ROLE %I NOLOGIN', r) FROM unnest(ARRAY['gpu_rent_owner', 'gpu_rent_app', 'gpu_rent_analyst']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- От current_user, а не от жёсткого имени: на Neon мигратор называется по-разному (neondb_owner или своя роль)
SELECT format('GRANT gpu_rent_owner TO %I WITH INHERIT TRUE, SET TRUE', current_user) \gexec
SQL

# Итог проверяется отдельно: GRANT мог пройти без эффекта, если роль уже была выдана другим грантором
psql_db -At -c "SELECT pg_has_role(current_user, 'gpu_rent_owner', 'USAGE') AND pg_has_role(current_user, 'gpu_rent_owner', 'SET')" \
    | grep -qx t || { echo "Ошибка: ${PGUSER:-текущая роль} не получила INHERIT и SET на gpu_rent_owner" >&2; exit 1; }
echo "bootstrap готов: $(psql_db -Atc 'SELECT current_user') может работать от имени gpu_rent_owner (БД $PGDATABASE)"

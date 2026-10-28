#!/usr/bin/env bash
# Локальная имитация Neon: проверка bootstrap_neon.sh, migrate.sh и create_login_role.sh без настоящего облака.
#   db/scripts/simulate_neon.sh             — создаёт роль-аналог neondb_owner и БД gpu_rent_neonsim, затем bootstrap,
#                                             миграции (дважды: второй запуск должен ничего не применять), LOGIN-роль,
#                                             демо-сид и итоговые проверки
#   db/scripts/simulate_neon.sh --cleanup   — удаляет БД, LOGIN-роль и роль-владельца
# Воспроизводит главные отличия Neon: мигратор не суперпользователь (LOGIN, CREATEROLE, CREATEDB, владелец БД), а в
# PostgreSQL 16 создатель роли получает ADMIN OPTION без INHERIT и SET. Подключение мигратора идёт через
# DATABASE_URL_DIRECT, как на Neon. Не воспроизводит: SSL и пулер, лимиты и засыпание compute, список разрешённых
# расширений Neon, служебные роли Neon (cloud_admin, neon_superuser).
#
# Подключение администратора — стандартные PGHOST/PGPORT/PGUSER (по умолчанию localhost и пользователь ОС, нужен
# суперпользователь). Роли gpu_rent_owner/app/analyst общие для всего кластера: если они уже есть (локальная dev-БД
# gpu_rent, тесты), роли-владельцу выдаётся только ADMIN OPTION без INHERIT и SET — это то состояние, в котором роли
# оказываются после CREATE ROLE в PG16 — и их не пересоздают. Поэтому LOGIN-роль здесь называется gpu_rent_web_neonsim:
# пароль настоящей gpu_rent_web не трогаем. Роли gpu_rent_owner/app/analyst --cleanup не удаляет, они общие.
# Переменные (пароли — только для этой проверки): NEONSIM_OWNER_PASSWORD, GPU_RENT_WEB_PASSWORD, DEMO_PASSWORD, ADMIN_PASSWORD.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sim_db="${NEONSIM_DB:-gpu_rent_neonsim}"
sim_owner="${NEONSIM_OWNER:-neonsim_owner}"
sim_web="${NEONSIM_WEB_ROLE:-gpu_rent_web_neonsim}"
export NEONSIM_OWNER_PASSWORD="${NEONSIM_OWNER_PASSWORD:-neonsim-check-12345}"
export GPU_RENT_WEB_PASSWORD="${GPU_RENT_WEB_PASSWORD:-neonsim-web-12345}"
export DEMO_PASSWORD="${DEMO_PASSWORD:-demo12345}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin12345}"
export GPU_RENT_WEB_ROLE="$sim_web"
scripts="$(dirname "${BASH_SOURCE[0]}")"

if [[ "$(psql_admin -Atc 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user')" != "t" ]]; then
    echo "Ошибка: для создания роли и БД имитации нужен суперпользователь (PGUSER)" >&2
    exit 1
fi

if [[ "${1:-}" == "--cleanup" ]]; then
    echo "== удаление БД $sim_db и ролей $sim_web, $sim_owner"
    PGOPTIONS="-c client_min_messages=warning" psql_admin -c "DROP DATABASE IF EXISTS \"$sim_db\" WITH (FORCE)" \
        -c "DROP ROLE IF EXISTS \"$sim_web\""
    # Членства, где грантор — имитируемый владелец, мешают DROP ROLE в PG16
    psql_admin -Atc "SELECT format('REVOKE %I FROM %I GRANTED BY %I', r.rolname, m.rolname, g.rolname)
        FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
             JOIN pg_roles g ON g.oid = am.grantor WHERE g.rolname = '$sim_owner'" | while read -r stmt; do
        [[ -n "$stmt" ]] && psql_admin -c "$stmt"
    done
    PGOPTIONS="-c client_min_messages=warning" psql_admin -c "DROP ROLE IF EXISTS \"$sim_owner\""
    echo "== готово"
    exit 0
fi

echo "== роль-аналог neondb_owner ($sim_owner) и БД $sim_db"
psql_admin -v owner="$sim_owner" -v db="$sim_db" <<'SQL'
\getenv owner_password NEONSIM_OWNER_PASSWORD
SELECT format('%s ROLE %I WITH LOGIN CREATEROLE CREATEDB NOSUPERUSER NOREPLICATION NOBYPASSRLS PASSWORD %L',
              CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') THEN 'ALTER' ELSE 'CREATE' END,
              :'owner', :'owner_password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
-- Состояние «роль создана этим владельцем» в PG16: ADMIN OPTION без INHERIT и SET. Только для ролей, которые уже есть в
-- кластере и в которых владелец ещё не состоит; если ролей нет, их создаст bootstrap_neon.sh
SELECT format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', r.rolname, :'owner')
FROM pg_roles r
WHERE r.rolname IN ('gpu_rent_owner', 'gpu_rent_app', 'gpu_rent_analyst')
  AND NOT pg_has_role(:'owner', r.oid, 'MEMBER') \gexec
SQL

# Дальше всё идёт под ролью-владельцем и по URL, как на Neon; суперпользовательские переменные в дочерние скрипты не попадают
owner_enc="$(printf '%s' "$NEONSIM_OWNER_PASSWORD" | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')"
export DATABASE_URL_DIRECT="postgres://${sim_owner}:${owner_enc}@${PGHOST}:${PGPORT:-5432}/${sim_db}?sslmode=disable"

echo "== bootstrap_neon.sh"
"$scripts/bootstrap_neon.sh"
echo "== migrate.sh (первый запуск)"
"$scripts/migrate.sh"
echo "== migrate.sh (повторный запуск: применять нечего)"
"$scripts/migrate.sh"
echo "== create_login_role.sh ($sim_web)"
"$scripts/create_login_role.sh"

as_owner() ( use_database_url; psql_db "$@" )

echo "== демо-сид (под мигратором)"
if [[ "$(as_owner -Atc 'SELECT count(*) FROM gpu_rent.users')" == "0" ]]; then
    as_owner -f "$DB_ROOT/seed/seed_demo.sql"
else
    echo "  пользователи уже есть, сид пропущен"
fi

echo "== итог"
as_owner -X <<SQL
\pset footer off
SELECT current_user AS migrator, r.rolsuper AS is_superuser, r.rolcreaterole AS createrole,
       pg_has_role(current_user, 'gpu_rent_owner', 'USAGE') AS inherit_owner,
       pg_has_role(current_user, 'gpu_rent_owner', 'SET') AS set_owner
FROM pg_roles r WHERE r.rolname = current_user;
SELECT count(*) AS migrations, max(version) AS last FROM gpu_rent.schema_migrations;
SELECT (SELECT count(*) FROM gpu_rent.users) AS users, (SELECT count(*) FROM gpu_rent.instances) AS instances,
       (SELECT count(*) FROM gpu_rent.gpus) AS gpus;
SELECT n.nspname AS schema, c.relowner::regrole AS owner, count(*) AS objects
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'gpu_rent' AND c.relkind IN ('r','p','v','m')
GROUP BY 1, 2;
SQL

echo "== проверки под LOGIN-ролью $sim_web (RLS и права действуют)"
(
    export PGUSER="$sim_web" PGPASSWORD="$GPU_RENT_WEB_PASSWORD"
    unset DATABASE_URL_DIRECT
    export PGDATABASE="$sim_db"
    psql_db -Atc "SELECT 'search_path='||current_setting('search_path')||' statement_timeout='||current_setting('statement_timeout')"
    psql_db -Atc "SELECT 'видимых строк в users без app.user_id: '||count(*) FROM gpu_rent.users" 2>&1 || true
    psql_db -Atc "SELECT 'видимых строк в instances без app.user_id: '||count(*) FROM gpu_rent.instances"
    # DDL не должен проходить
    if psql_db -c "CREATE TABLE gpu_rent.zz_probe(i int)" >/dev/null 2>&1; then echo "ОШИБКА: CREATE TABLE разрешён"; exit 1; else echo "CREATE TABLE запрещён: ok"; fi
)

echo "== готово: БД $sim_db; для приложения: postgres://${sim_web}:<GPU_RENT_WEB_PASSWORD>@${PGHOST}:${PGPORT:-5432}/${sim_db}"

#!/usr/bin/env bash
# Копия БД и проверка, что из неё можно восстановиться: pg_dump (custom, без владельцев и прав) боевой БД,
# восстановление в отдельную БД локального/сервисного Postgres, сравнение числа строк ключевых таблиц.
#   SRC_URL=postgres://... docs/deploy/backup_restore_check.sh
# Переменные:
#   SRC_URL      строка подключения к БД-источнику (на Neon — direct endpoint, не пулер)
#   DUMP_FILE    куда писать дамп (по умолчанию backup.dump)
#   RESTORE_DB   имя БД для проверки восстановления (по умолчанию restore_check, пересоздаётся)
#   SUMMARY_FILE куда дописать markdown-сводку (в Actions — $GITHUB_STEP_SUMMARY; по умолчанию stdout)
# Целевой кластер — стандартные PGHOST/PGPORT/PGUSER/PGPASSWORD, нужен суперпользователь (расширения).
set -uo pipefail

: "${SRC_URL:?задайте SRC_URL}"
DUMP_FILE="${DUMP_FILE:-backup.dump}"
RESTORE_DB="${RESTORE_DB:-restore_check}"
SUMMARY_FILE="${SUMMARY_FILE:-/dev/stdout}"
TABLES=(users instances transactions usage_records)

count() { # count <conninfo|имя БД> <таблица>
    psql -X -At -v ON_ERROR_STOP=1 "$1" -c "SELECT count(*) FROM gpu_rent.$2"
}

# Индексированные массивы, а не ассоциативные: скрипт должен работать и в bash 3.2 (macOS)
before=(); after=(); restored=()
for i in "${!TABLES[@]}"; do before[i]=$(count "$SRC_URL" "${TABLES[i]}") || exit 1; done

pg_dump --format=custom --no-owner --no-privileges --file="$DUMP_FILE" "$SRC_URL" || { echo "pg_dump завершился с ошибкой" >&2; exit 1; }
size=$(du -h "$DUMP_FILE" | cut -f1)

for i in "${!TABLES[@]}"; do after[i]=$(count "$SRC_URL" "${TABLES[i]}") || exit 1; done

# Роли кластера не входят в дамп БД. Политики RLS ссылаются на них по имени, без ролей восстановление падало бы.
psql -X -q -v ON_ERROR_STOP=1 -d postgres \
    -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$RESTORE_DB\"" || exit 1
psql -X -q -d "$RESTORE_DB" <<'SQL' || exit 1
DO $$
DECLARE r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['gpu_rent_owner', 'gpu_rent_app', 'gpu_rent_analyst', 'gpu_rent_web'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
END $$;
SQL

restore_log="$(mktemp)"
pg_restore --no-owner --no-privileges --dbname="$RESTORE_DB" "$DUMP_FILE" 2> "$restore_log"
restore_rc=$?
errors=$(grep -c '^pg_restore: error' "$restore_log" || true)

status=OK
for i in "${!TABLES[@]}"; do
    restored[i]=$(count "$RESTORE_DB" "${TABLES[i]}") || { restored[i]=ошибка; status=FAIL; continue; }
    # Источник живой: за время дампа строки могли добавиться, поэтому число в копии должно лежать между замерами до и после
    if [[ ! ${restored[i]} =~ ^[0-9]+$ ]] || (( restored[i] < before[i] || restored[i] > after[i] )); then status=FAIL; fi
done
if [[ $status == OK && ( $restore_rc -ne 0 || $errors -gt 0 ) ]]; then status="OK (pg_restore сообщил об ошибках: $errors)"; fi

{
    echo "### Резервная копия БД: $status"
    echo
    echo "Дамп: custom, без владельцев и прав, размер $size. Восстановлен в БД \`$RESTORE_DB\`."
    echo
    echo "| Таблица | до дампа | после дампа | в восстановленной копии |"
    echo "|---|---:|---:|---:|"
    for i in "${!TABLES[@]}"; do echo "| ${TABLES[i]} | ${before[i]} | ${after[i]} | ${restored[i]} |"; done
    if [[ $errors -gt 0 ]]; then
        echo
        echo "Ошибки pg_restore (первые 10):"
        echo '```'
        grep '^pg_restore: error' "$restore_log" | head -10
        echo '```'
    fi
} >> "$SUMMARY_FILE"

rm -f "$restore_log"
[[ $status == FAIL ]] && exit 1
exit 0

#!/usr/bin/env bash
# Прогоняет сценарии db/bench/*.sql («до/после» EXPLAIN (ANALYZE, BUFFERS), размеры таблиц) и сохраняет
# вывод каждого в db/bench/results/<имя>.txt. Нужна БД с сидом (db/scripts/reset.sh).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

results="$DB_ROOT/bench/results"
mkdir -p "$results"
seed_seconds="н/д"
[[ -f "$results/.seed_seconds" ]] && seed_seconds="$(cat "$results/.seed_seconds")"

for file in "$DB_ROOT"/bench/*.sql; do
    name="$(basename "$file" .sql)"
    echo "== $name"
    psql -X -q -v ON_ERROR_STOP=1 -v seed_seconds="$seed_seconds" -d "$PGDATABASE" -f "$file" > "$results/$name.txt" 2>&1
done
echo "== готово: $results"

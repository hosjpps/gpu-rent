#!/usr/bin/env bash
# Пересоздаёт БД с нуля: DROP + CREATE, миграции по порядку (ON_ERROR_STOP), сид.
#   db/scripts/reset.sh             — миграции + сид
#   db/scripts/reset.sh --no-seed   — только миграции
# Переменные: PGDATABASE (по умолчанию gpu_rent), PGHOST, PGPORT, PGUSER. Нужен суперпользователь кластера.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

with_seed=1
[[ "${1:-}" == "--no-seed" ]] && with_seed=0

echo "== БД $PGDATABASE: пересоздание"
recreate_db "$PGDATABASE"

echo "== миграции"
apply_migrations "$PGDATABASE"

if [[ $with_seed -eq 1 ]]; then
    echo "== сид"
    started=$(date +%s)
    psql_db -f "$DB_ROOT/seed/seed.sql"
    elapsed=$(( $(date +%s) - started ))
    echo "сид выполнен за ${elapsed} с"
    mkdir -p "$DB_ROOT/bench/results"
    echo "$elapsed" > "$DB_ROOT/bench/results/.seed_seconds"
fi
echo "== готово"

#!/usr/bin/env bash
# Прогоняет все тесты db/tests/NN_*.sql (каждый — в BEGIN ... ROLLBACK, провал = ошибка psql) и
# конкурентный тест db/tests/concurrency.sh. Итог PASS/FAIL, код возврата 1 при любом провале.
#   SKIP_CONCURRENCY=1 db/scripts/test.sh — без конкурентного теста (он создаёт временную БД)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

passed=0
failed=0
checks_total=0

for file in "$DB_ROOT"/tests/[0-9][0-9]_*.sql; do
    name="$(basename "$file" .sql)"
    if out="$(psql -X -q -v ON_ERROR_STOP=1 -d "$PGDATABASE" -f "$file" 2>&1)"; then
        checks=$(grep -c ' ok - ' <<<"$out" || true)
        printf 'PASS  %-34s %3d checks\n' "$name" "$checks"
        passed=$((passed + 1))
        checks_total=$((checks_total + checks))
    else
        printf 'FAIL  %s\n' "$name"
        grep -v ' ok - ' <<<"$out" | sed 's/^/        /'
        failed=$((failed + 1))
    fi
done

if [[ "${SKIP_CONCURRENCY:-0}" != "1" ]]; then
    if out="$("$DB_ROOT/tests/concurrency.sh" 2>&1)"; then
        checks=$(grep -c ' ok - ' <<<"$out" || true)
        printf 'PASS  %-34s %3d checks\n' "concurrency" "$checks"
        passed=$((passed + 1))
        checks_total=$((checks_total + checks))
    else
        printf 'FAIL  concurrency\n'
        sed 's/^/        /' <<<"$out"
        failed=$((failed + 1))
    fi
fi

echo "----"
if [[ $failed -eq 0 ]]; then
    echo "PASS: $passed файлов, $checks_total проверок"
else
    echo "FAIL: провалено $failed, пройдено $passed"
    exit 1
fi

#!/usr/bin/env bash
# Конкурентные проверки на нескольких одновременных сессиях psql. Строки БД фиксируются (COMMIT),
# поэтому тест работает во временной БД gpu_rent_conc (только миграции, без сида), которая удаляется в конце.
# Старт всех сессий одновременно обеспечивает барьер: общая advisory-блокировка, которую держит отдельная сессия.
set -euo pipefail
# shellcheck source=../scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../scripts/lib.sh"

CONC_DB="${CONC_DB:-gpu_rent_conc}"
work="$(mktemp -d)"
failed=0
cleanup() {
    psql_admin -c "DROP DATABASE IF EXISTS \"$CONC_DB\" WITH (FORCE)" > /dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

check() {   # check "описание" <код возврата проверки>
    if [[ "$2" -eq 0 ]]; then echo " ok - $1"; else echo " FAIL - $1"; failed=1; fi
}
sql() { psql -X -q -At -v ON_ERROR_STOP=1 -d "$CONC_DB" "$@"; }
sys_sql() { PGOPTIONS='-c app.user_role=system' sql "$@"; }

# Запускает N сессий, каждая выполняет одно SQL-выражение в своей транзакции; результаты — в $work/<префикс>.<i>
run_parallel() {   # run_parallel <префикс> <N> <SQL, где {i} — номер сессии>
    local prefix="$1" n="$2" stmt="$3" i pids=()
    psql -X -q -At -d "$CONC_DB" -c "SELECT pg_advisory_lock(42)" -c "SELECT pg_sleep(1.5)" -c "SELECT pg_advisory_unlock(42)" > /dev/null &
    pids+=($!)
    sleep 0.3
    for ((i = 1; i <= n; i++)); do
        (
            PGOPTIONS='-c app.user_role=system -c client_min_messages=warning' \
            psql -X -q -At -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -d "$CONC_DB" \
                 -c "BEGIN" -c "SELECT pg_advisory_xact_lock_shared(42)" -c "${stmt//\{i\}/$i}" -c "COMMIT" \
                 > "$work/$prefix.$i" 2>&1 || true
        ) &
        pids+=($!)
    done
    wait "${pids[@]}"
}

echo "-- подготовка временной БД $CONC_DB"
recreate_db "$CONC_DB"
apply_migrations "$CONC_DB" > /dev/null

sys_sql > /dev/null <<'SQL'
INSERT INTO datacenters (code, name, city, country) VALUES ('CON-1', 'conc', 'Москва', 'RU');
INSERT INTO gpu_models (vendor, name, vram_gb, fp32_tflops) VALUES ('NVIDIA', 'CON-A', 24, 80);
INSERT INTO nodes (datacenter_id, hostname, cpu_cores, ram_gb, disk_gb) VALUES (1, 'con-n1', 32, 256, 2000);
INSERT INTO gpus (node_id, gpu_model_id, slot_index, serial) SELECT 1, 1, s, 'con-' || s FROM generate_series(0, 3) s;
INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
    VALUES (1, 1, 'on_demand', 100, tstzrange(now() - interval '1 day', NULL));
INSERT INTO templates (name, docker_image, default_disk_gb, is_public) VALUES ('t', 'img', 50, true);
INSERT INTO users (email, password_hash, full_name)
    SELECT 'c' || s || '@example.test', '$2b$12$' || repeat('a', 53), 'Конкурент ' || s FROM generate_series(1, 12) s;
-- по платежу на пользователя; 13-й платёж (user 1) понадобится для проверки идемпотентности
INSERT INTO payments (user_id, provider, provider_payment_id, amount)
    SELECT s, 'test', 'p' || s, 10000 FROM generate_series(1, 12) s;
INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (1, 'test', 'same-payment', 777);
SQL
sys_sql -c "SELECT fn_topup(id) FROM payments WHERE provider_payment_id <> 'same-payment'" > /dev/null

# ---------------------------------------------------------------------------------------------
echo "-- 1. 12 одновременных запусков на ноде с 4 GPU"
run_parallel start 12 "SELECT 'STARTED ' || fn_start_instance({i}, 1, 1, 1, 'on_demand', 1, 'conc-{i}')"
started=$(cat "$work"/start.* | grep -c '^STARTED ' || true)
refused=$(cat "$work"/start.* | grep -cE 'GR001|23P01' || true)
other=$(cat "$work"/start.* | grep -E '^ERROR' | grep -vcE 'GR001|23P01' || true)
echo "   (отказы: GR001 нехватка GPU — $(cat "$work"/start.* | grep -c 'GR001' || true), 23P01 сработал EXCLUDE — $(cat "$work"/start.* | grep -c '23P01' || true))"
check "ровно 4 запуска удались (по числу GPU), удалось: $started" $([[ "$started" -eq 4 ]]; echo $?)
check "остальные 8 отклонены с GR001/23P01, отклонено: $refused" $([[ "$refused" -eq 8 ]]; echo $?)
check "других ошибок нет (взаимоблокировок, таймаутов): $other" $([[ "$other" -eq 0 ]]; echo $?)
open_gpus=$(sql -c "SELECT count(DISTINCT gpu_id) FROM instance_gpus WHERE upper_inf(allocated_during)")
open_rows=$(sql -c "SELECT count(*) FROM instance_gpus WHERE upper_inf(allocated_during)")
check "каждая GPU выделена ровно одному инстансу: открытых аллокаций $open_rows, разных GPU $open_gpus" $([[ "$open_rows" -eq 4 && "$open_gpus" -eq 4 ]]; echo $?)
running=$(sql -c "SELECT count(*) FROM instances WHERE status = 'running'")
check "в БД ровно 4 работающих инстанса: $running" $([[ "$running" -eq 4 ]]; echo $?)

# ---------------------------------------------------------------------------------------------
echo "-- 2. 10 одновременных fn_topup одного платежа"
pay_id=$(sql -c "SELECT id FROM payments WHERE provider_payment_id = 'same-payment'")
before=$(sql -c "SELECT balance FROM users WHERE id = 1")
run_parallel topup 10 "SELECT 'RESULT ' || fn_topup($pay_id)"
credited=$(cat "$work"/topup.* | grep -c '^RESULT t' || true)
skipped=$(cat "$work"/topup.* | grep -c '^RESULT f' || true)
after=$(sql -c "SELECT balance FROM users WHERE id = 1")
txs=$(sql -c "SELECT count(*) FROM transactions WHERE payment_id = $pay_id")
check "зачислил ровно один вызов (true), остальные вернули false: $credited / $skipped" $([[ "$credited" -eq 1 && "$skipped" -eq 9 ]]; echo $?)
check "платёж попал в журнал один раз: $txs" $([[ "$txs" -eq 1 ]]; echo $?)
check "баланс вырос ровно на 777: $before -> $after" $([[ "$(sql -c "SELECT $after - $before = 777")" == "t" ]]; echo $?)

# ---------------------------------------------------------------------------------------------
echo "-- 3. параллельные проходы биллинга и остановка одного и того же инстанса"
inst=$(sql -c "SELECT id FROM instances WHERE status = 'running' ORDER BY user_id LIMIT 1")
sql -c "UPDATE instances SET started_at = started_at - interval '3 hours', last_billed_at = last_billed_at - interval '3 hours' WHERE id = '$inst'" > /dev/null
t_start=$(sql -c "SELECT last_billed_at FROM instances WHERE id = '$inst'")
# 6 проходов с одной границей + 2 остановки + 2 прохода без фиксированной границы
run_parallel mixA 6 "SELECT 'BILL ' || o_amount FROM fn_bill_usage('$t_start'::timestamptz + interval '1 hour')"
run_parallel mixB 4 "SELECT CASE WHEN {i} <= 2 THEN 'STOP ' || fn_stop_instance('$inst')::text ELSE 'BILL ' || (SELECT o_amount FROM fn_bill_usage()) END"
status=$(sql -c "SELECT status FROM instances WHERE id = '$inst'")
check "инстанс остановлен один раз, статус: $status" $([[ "$status" == "stopped" ]]; echo $?)
gaps=$(sql -c "SELECT count(*) FROM (SELECT period_start, lag(period_end) OVER (ORDER BY period_start) AS prev_end FROM usage_records WHERE instance_id = '$inst') s WHERE prev_end IS NOT NULL AND period_start <> prev_end")
check "интервалы потребления идут встык, без наложений и пропусков: нарушений $gaps" $([[ "$gaps" -eq 0 ]]; echo $?)
span=$(sql -c "SELECT abs(extract(epoch FROM (max(period_end) - min(period_start))) - sum(quantity)) < 0.001 FROM usage_records WHERE instance_id = '$inst'")
check "суммарное количество секунд равно длине учтённого периода (ничего не списано дважды)" $([[ "$span" == "t" ]]; echo $?)
first_start=$(sql -c "SELECT min(period_start) = '$t_start'::timestamptz FROM usage_records WHERE instance_id = '$inst'")
check "учёт начался ровно с исходной last_billed_at" $([[ "$first_start" == "t" ]]; echo $?)
mismatch=$(sql -c "SELECT count(*) FROM users u WHERE u.balance IS DISTINCT FROM coalesce((SELECT sum(amount) FROM transactions t WHERE t.user_id = u.id), 0)")
check "баланс каждого пользователя равен сумме журнала: расхождений $mismatch" $([[ "$mismatch" -eq 0 ]]; echo $?)
dup=$(sql -c "SELECT count(*) FROM (SELECT usage_id FROM transactions WHERE type = 'charge' GROUP BY usage_id, usage_period_start HAVING count(*) > 1) s")
check "ни одно потребление не списано дважды: $dup" $([[ "$dup" -eq 0 ]]; echo $?)

exit $failed

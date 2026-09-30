-- 09: партиционирование usage_records: маршрутизация по месяцам (границы в UTC), DEFAULT-партиция,
-- partition pruning, fn_ensure_usage_partition, индексы и защита каждой партиции.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql

CREATE FUNCTION pg_temp.put_usage(p_start timestamptz) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_inst uuid := (SELECT id FROM instances WHERE user_id = pg_temp.fx('u1') LIMIT 1);
    v_part text;
BEGIN
    IF v_inst IS NULL THEN
        v_inst := pg_temp.raw_instance(pg_temp.fx('u1'), pg_temp.fx('n1'), pg_temp.fx('ma'));
    END IF;
    INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount)
    VALUES (pg_temp.fx('u1'), v_inst, 'gpu', p_start, p_start + interval '1 minute', 60, 1.6667)
    RETURNING tableoid::regclass::text INTO v_part;
    RETURN v_part;
END
$$;

CREATE FUNCTION pg_temp.plan_of(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    r record; v text := '';
BEGIN
    FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) ' || p_sql LOOP
        v := v || (r."QUERY PLAN") || E'\n';
    END LOOP;
    RETURN v;
END
$$;

DO $$
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'gpu_rent.usage_records'::regclass), 16,
                              '15 monthly partitions 2025-10..2026-12 plus the default one');

    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2026-03-15 10:00:00+00'), 'usage_records_2026_03', 'a March 2026 row goes to usage_records_2026_03');
    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2025-10-01 00:00:00+00'), 'usage_records_2025_10', 'lower bound is inclusive: 2025-10-01 00:00 -> 2025_10');
    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2026-01-31 23:59:59.999999+00'), 'usage_records_2026_01', 'last microsecond of January -> 2026_01');
    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2026-02-01 00:00:00+00'), 'usage_records_2026_02', 'first microsecond of February -> 2026_02');
    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2026-12-31 23:00:00+00'), 'usage_records_2026_12', 'December 2026 -> 2026_12');

    -- границы задаются в UTC независимо от часового пояса сессии
    SET LOCAL timezone = 'Europe/Moscow';
    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2026-03-31 22:00:00+00'), 'usage_records_2026_03', 'session timezone does not shift partitions (22:00 UTC = 01:00 MSK next day)');
    SET LOCAL timezone = 'UTC';

    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2025-09-30 23:59:59+00'), 'usage_records_default', 'a row before the first partition falls into default');
    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2030-05-10 00:00:00+00'), 'usage_records_default', 'a row after the last partition falls into default');
END
$$;

-- Pruning: запрос за месяц читает одну партицию.
DO $$
DECLARE
    v text := pg_temp.plan_of('SELECT sum(amount) FROM usage_records WHERE user_id = 1 AND period_start >= ''2026-08-01 00:00:00+00'' AND period_start < ''2026-09-01 00:00:00+00''');
BEGIN
    PERFORM pg_temp.assert_true(v LIKE '%usage_records_2026_08%', 'pruning: August partition is scanned');
    PERFORM pg_temp.assert_true(v NOT LIKE '%usage_records_2026_07%' AND v NOT LIKE '%usage_records_2026_09%' AND v NOT LIKE '%usage_records_2025_10%',
                                'pruning: other months are not scanned');
    v := pg_temp.plan_of('SELECT sum(amount) FROM usage_records WHERE user_id = 1 AND date_trunc(''month'', period_start) = ''2026-08-01''');
    PERFORM pg_temp.assert_true(v LIKE '%usage_records_2025_10%' AND v LIKE '%usage_records_2026_08%' AND v LIKE '%usage_records_2026_12%',
                                'a non-sargable predicate defeats pruning: every partition is scanned (why queries filter by raw period_start)');
END
$$;

-- fn_ensure_usage_partition
DO $$
DECLARE
    v_name text; v_next text := 'usage_records_' || to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month', 'YYYY_MM');
BEGIN
    PERFORM pg_temp.assert_eq(fn_ensure_usage_partition('2026-03-20'), 'usage_records_2026_03', 'existing partition: name returned, nothing created');
    PERFORM pg_temp.assert_eq(fn_ensure_usage_partition(), v_next, 'no argument: the partition of the next month');

    PERFORM pg_temp.assert_true(to_regclass('gpu_rent.usage_records_2027_01') IS NULL, 'partition 2027-01 does not exist yet');
    v_name := fn_ensure_usage_partition('2027-01-15');
    PERFORM pg_temp.assert_eq(v_name, 'usage_records_2027_01', 'partition for 2027-01 is created');
    PERFORM pg_temp.assert_eq(fn_ensure_usage_partition('2027-01-01'), 'usage_records_2027_01', 'second call is idempotent');
    PERFORM pg_temp.assert_eq(pg_temp.put_usage('2027-01-20 12:00:00+00'), 'usage_records_2027_01', 'rows of the new month are routed to the new partition');

    -- в новой партиции есть всё то же, что и в остальных
    PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'gpu_rent' AND tablename = 'usage_records_2027_01' AND indexdef LIKE '%USING brin (period_start)%'),
                                'new partition got the BRIN index automatically');
    PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'gpu_rent' AND tablename = 'usage_records_2027_01' AND indexdef LIKE '%(user_id, period_start)%'),
                                'new partition got the (user_id, period_start) index automatically');

    -- если в DEFAULT уже лежат строки нужного месяца, PostgreSQL не даст создать партицию: их надо переносить
    PERFORM pg_temp.assert_raises(format('SELECT fn_ensure_usage_partition(%L)', '2030-05-01'), '23514', 'partition cannot be created over rows already stored in default');
END
$$;

-- Защита каждой партиции (включая только что созданную и default)
DO $$
BEGIN
    PERFORM pg_temp.assert_eq(
        (SELECT count(*)::int FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'gpu_rent.usage_records'::regclass
           AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND (t.tgtype & 32) <> 0)),   -- 32 = TRUNCATE
        0, 'every partition has its own BEFORE TRUNCATE trigger');
    PERFORM pg_temp.assert_eq(
        (SELECT count(*)::int FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'gpu_rent.usage_records'::regclass
           AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND (t.tgtype & 16) <> 0 AND (t.tgtype & 8) <> 0 AND (t.tgtype & 1) <> 0)),  -- UPDATE, DELETE, row
        0, 'every partition has the append-only row trigger (cloned from the parent)');
    PERFORM pg_temp.assert_raises('UPDATE usage_records_2026_03 SET amount = 0', '23001', 'direct UPDATE of a partition is rejected');
    PERFORM pg_temp.assert_raises('DELETE FROM usage_records_2026_03', '23001', 'direct DELETE from a partition is rejected');
    PERFORM pg_temp.assert_raises('TRUNCATE usage_records_2026_03, transactions', '23001', 'TRUNCATE of a partition is rejected');
    PERFORM pg_temp.assert_raises('UPDATE usage_records SET period_start = period_start + interval ''40 days''', '23001', 'moving a row between partitions is rejected');
END
$$;
ROLLBACK;

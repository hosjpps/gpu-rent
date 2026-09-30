-- 0006: месячные партиции usage_records (NFR-05) и функция их создания.
-- Диапазон 2025-10 .. 2026-12 + DEFAULT-партиция как страховка: строка за пределами
-- созданных месяцев не теряется и не роняет биллинг, но подлежит переносу (см. 09_partitioning).
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

-- Создаёт партицию месяца p_month (любая дата месяца), если её ещё нет. Возвращает имя партиции.
-- Без аргумента — следующий месяц относительно текущего (UTC): вызывается планировщиком заранее.
-- Если в DEFAULT уже лежат строки этого месяца, PostgreSQL откажет в создании — их надо перенести.
CREATE FUNCTION fn_ensure_usage_partition(p_month date DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_from date := date_trunc('month', coalesce(p_month::timestamp,
                                                (now() AT TIME ZONE 'UTC') + interval '1 month'))::date;
    v_name text;
BEGIN
    v_name := 'usage_records_' || to_char(v_from, 'YYYY_MM');

    IF to_regclass('gpu_rent.' || quote_ident(v_name)) IS NULL THEN
        -- двое одновременных вызовов не должны оба пытаться создать одну партицию
        PERFORM pg_advisory_xact_lock(hashtext('gpu_rent.fn_ensure_usage_partition'));
        IF to_regclass('gpu_rent.' || quote_ident(v_name)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE gpu_rent.%I PARTITION OF gpu_rent.usage_records FOR VALUES FROM (%L) TO (%L)',
                v_name,
                to_char(v_from, 'YYYY-MM-DD') || ' 00:00:00+00',
                to_char(v_from + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+00');
            -- триггеры уровня оператора на партиции не наследуются, добавляем вручную
            EXECUTE format(
                'CREATE TRIGGER trg_usage_records_no_truncate BEFORE TRUNCATE ON gpu_rent.%I '
                'FOR EACH STATEMENT EXECUTE FUNCTION gpu_rent.fn_forbid_modification()', v_name);
        END IF;
    END IF;
    RETURN v_name;
END
$$;

COMMENT ON FUNCTION fn_ensure_usage_partition(date) IS
    'Идемпотентно создаёт месячную партицию usage_records. Без аргумента — на месяц вперёд от текущего (UTC).';

CREATE TABLE usage_records_default PARTITION OF usage_records DEFAULT;
CREATE TRIGGER trg_usage_records_no_truncate BEFORE TRUNCATE ON usage_records_default
    FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_modification();

DO $$
DECLARE
    m date;
BEGIN
    FOR m IN SELECT g::date FROM generate_series('2025-10-01'::date, '2026-12-01'::date, interval '1 month') AS g LOOP
        PERFORM fn_ensure_usage_partition(m);
    END LOOP;
END
$$;

COMMENT ON TABLE usage_records_default IS
    'Страховочная партиция: всё, что не попало в месячные. Должна оставаться пустой (проверяется мониторингом).';

INSERT INTO schema_migrations (version) VALUES ('0006_partitioning');
COMMIT;

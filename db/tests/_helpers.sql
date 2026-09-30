-- Общие проверки для тестов. Подключается через \ir внутри транзакции теста;
-- функции живут в pg_temp и исчезают вместе с сессией. Провал = RAISE EXCEPTION, psql завершается с ошибкой.

CREATE FUNCTION pg_temp.ok(p_msg text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RAISE NOTICE 'ok - %', p_msg; END $$;

CREATE FUNCTION pg_temp.assert_true(p_cond boolean, p_msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_cond IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL - %', p_msg;
    END IF;
    RAISE NOTICE 'ok - %', p_msg;
END
$$;

CREATE FUNCTION pg_temp.assert_eq(p_actual anycompatible, p_expected anycompatible, p_msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_actual IS DISTINCT FROM p_expected THEN
        RAISE EXCEPTION 'FAIL - %: expected %, got %', p_msg, p_expected, p_actual;
    END IF;
    RAISE NOTICE 'ok - %', p_msg;
END
$$;

-- Выполняет p_sql и требует ошибку с заданным SQLSTATE (подтранзакция откатывается, основная жива).
CREATE FUNCTION pg_temp.assert_raises(p_sql text, p_sqlstate text, p_msg text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_state text;
    v_err   text;
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
        IF v_state = p_sqlstate THEN
            RAISE NOTICE 'ok - % [%]', p_msg, v_state;
            RETURN;
        END IF;
        RAISE EXCEPTION 'FAIL - %: expected SQLSTATE %, got % (%)', p_msg, p_sqlstate, v_state, v_err;
    END;
    RAISE EXCEPTION 'FAIL - %: statement succeeded but had to fail', p_msg;
END
$$;

-- Значения фикстуры хранятся в настройках транзакции (fx.<ключ>), чтобы быть видимыми
-- и из DO-блоков, и из-под SET ROLE.
CREATE FUNCTION pg_temp.fx(p_key text) RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT current_setting('fx.' || p_key)::bigint $$;

CREATE FUNCTION pg_temp.fxt(p_key text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT current_setting('fx.' || p_key) $$;

-- Пользовательский контекст приложения для текущей транзакции.
CREATE FUNCTION pg_temp.as_user(p_user_id bigint, p_role text DEFAULT 'client') RETURNS void
LANGUAGE sql AS $$
    SELECT set_config('app.user_id', p_user_id::text, true), set_config('app.user_role', p_role, true)
$$;

CREATE FUNCTION pg_temp.as_system() RETURNS void
LANGUAGE sql AS $$ SELECT set_config('app.user_id', '', true), set_config('app.user_role', 'system', true) $$;

-- Сдвигает учётные даты инстанса в прошлое на p_delta: «он работает уже столько», не дожидаясь
-- реального времени. Аллокации GPU не трогаем: на биллинг они не влияют, а сдвиг открытой аллокации
-- после повторного запуска налез бы на закрытую предыдущую.
CREATE FUNCTION pg_temp.age_instance(p_id uuid, p_delta interval) RETURNS void
LANGUAGE sql AS $$
    UPDATE instances SET created_at = created_at - p_delta, started_at = started_at - p_delta,
                         last_billed_at = last_billed_at - p_delta WHERE id = p_id
$$;

-- «Сырой» инстанс в обход fn_start_instance (для проверки ограничений таблиц напрямую). GPU не выделяет.
CREATE FUNCTION pg_temp.raw_instance(p_user bigint, p_node bigint, p_model bigint, p_count integer DEFAULT 1,
                                     p_status instance_status DEFAULT 'running') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, name, pricing_type, gpu_count,
                           container_disk_gb, price_per_hour_snapshot, status, started_at, last_billed_at, terminated_at)
    VALUES (p_user, p_node, p_model, pg_temp.fx('tpl'), 'raw', 'on_demand', p_count, 50, 100 * p_count, p_status,
            CASE WHEN p_status IN ('running', 'stopped', 'terminated') THEN now() END,
            CASE WHEN p_status = 'running' THEN now() END,
            CASE WHEN p_status = 'terminated' THEN now() END)
    RETURNING id INTO v_id;
    RETURN v_id;
END
$$;

-- Убирает тома фикстуры из биллинга (удаляет «задним числом»), чтобы суммы GPU-тестов были круглыми.
-- Тома сида не трогаем: у них могут быть живые инстансы.
CREATE FUNCTION pg_temp.no_storage() RETURNS void
LANGUAGE sql AS $$
    UPDATE volumes SET status = 'deleted', deleted_at = created_at, last_billed_at = created_at
     WHERE user_id IN (pg_temp.fx('u1'), pg_temp.fx('u2'), pg_temp.fx('u3'))
$$;

-- 0013: веб-слой приложения (П5): сессии, ограничение частоты входа, подтверждение email, вход по API-ключу,
-- биллинг «при обращении», приём уведомлений платёжного шлюза, журнал проходов биллинга.
--
-- Принципы:
--   * новые таблицы приложению напрямую недоступны: ни одного GRANT, всё через функции SECURITY DEFINER
--     с фиксированным search_path; EXECUTE получает только gpu_rent_app (LOGIN-роль gpu_rent_web — его член);
--   * до входа пользователя нет app.user_id, поэтому функции входа/регистрации/резолва сессии не опираются на RLS;
--   * ужесточение, а не расширение прав 0011: хэш пароля и роль пользователя приложению напрямую не видны и не
--     изменяются (раньше SELECT на users открывал password_hash всем строкам), у users и templates появляется RLS;
--   * миграция только добавляет объекты: откат кода (Instant Rollback) на предыдущую версию её не ломает.
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

-- ---------------------------------------------------------------------------------------------
-- Таблицы
-- ---------------------------------------------------------------------------------------------
-- Сессия браузера. В БД только SHA-256 токена из cookie: утечка дампа не даёт войти.
CREATE TABLE sessions (
    id           bigint GENERATED ALWAYS AS IDENTITY,
    user_id      bigint      NOT NULL,
    token_hash   bytea       NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    ip           inet,
    user_agent   text,
    CONSTRAINT pk_sessions PRIMARY KEY (id),
    CONSTRAINT uq_sessions_token UNIQUE (token_hash),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT ck_sessions_hash_len CHECK (octet_length(token_hash) = 32),
    CONSTRAINT ck_sessions_expiry CHECK (expires_at > created_at)
);
CREATE INDEX idx_sessions_user    ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Попытки входа/регистрации/смены пароля. Счётчик живёт в БД, а не в памяти процесса: на serverless
-- каждый запрос может уйти в новый экземпляр функции, и in-memory лимитер видел бы только свои запросы.
CREATE TABLE auth_attempts (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    scope      text        NOT NULL,   -- login_email, login_ip, register_ip, password, resend
    key        text        NOT NULL,   -- email, IP-адрес или id пользователя
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT pk_auth_attempts PRIMARY KEY (id)
);
CREATE INDEX idx_auth_attempts_key     ON auth_attempts (scope, key, created_at);
CREATE INDEX idx_auth_attempts_created ON auth_attempts (created_at);

-- Токены подтверждения email (FR-01): в БД только хэш, срок жизни, признак использования.
CREATE TABLE email_tokens (
    id         bigint GENERATED ALWAYS AS IDENTITY,
    user_id    bigint      NOT NULL,
    token_hash bytea       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    CONSTRAINT pk_email_tokens PRIMARY KEY (id),
    CONSTRAINT uq_email_tokens_hash UNIQUE (token_hash),
    CONSTRAINT fk_email_tokens_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT ck_email_tokens_hash_len CHECK (octet_length(token_hash) = 32)
);
CREATE INDEX idx_email_tokens_user ON email_tokens (user_id);

-- Журнал проходов биллинга: по нему /api/health?deep=1 отвечает «когда биллинг шёл в последний раз».
-- Отдельная таблица, а не audit_log: проход бывает каждые 30 минут, и админ-журнал утонул бы в этих строках.
CREATE TABLE billing_runs (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    finished_at timestamptz NOT NULL DEFAULT now(),
    details     jsonb       NOT NULL DEFAULT '{}',
    CONSTRAINT pk_billing_runs PRIMARY KEY (id)
);
CREATE INDEX idx_billing_runs_finished ON billing_runs (finished_at DESC);

COMMENT ON TABLE sessions IS 'Сессии веб-приложения: cookie хранит случайный токен, здесь только его SHA-256. Скользящий срок expires_at.';
COMMENT ON TABLE auth_attempts IS 'Попытки входа/регистрации для ограничения частоты (fn_auth_throttle_hit). Старые строки удаляет fn_web_cleanup.';
COMMENT ON TABLE email_tokens IS 'Токены подтверждения email: sha256 токена, срок, время использования.';
COMMENT ON TABLE billing_runs IS 'Завершённые проходы биллинга (cron, GitHub Actions): время и итог.';

-- ---------------------------------------------------------------------------------------------
-- Ограничение частоты. Атомарно: проверка и запись попытки под одной advisory-блокировкой ключа,
-- поэтому параллельные запросы не проскочат лимит. Возвращает 0 (попытка принята и записана)
-- или число секунд до следующей разрешённой попытки (попытка не записывается).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_auth_throttle_hit(p_scope text, p_key text, p_limit integer, p_window_seconds integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_count  integer;
    v_oldest timestamptz;
    v_window interval := make_interval(secs => p_window_seconds);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('auth_attempts:' || p_scope || ':' || p_key, 0));
    SELECT count(*), min(a.created_at) INTO v_count, v_oldest
    FROM auth_attempts a
    WHERE a.scope = p_scope AND a.key = p_key AND a.created_at > clock_timestamp() - v_window;
    IF v_count >= p_limit THEN
        RETURN greatest(1, ceil(extract(epoch FROM v_oldest + v_window - clock_timestamp()))::integer);
    END IF;
    INSERT INTO auth_attempts (scope, key) VALUES (p_scope, p_key);
    RETURN 0;
END
$$;

-- Успешный вход сбрасывает счётчик неудач по этому ключу.
CREATE FUNCTION fn_auth_throttle_clear(p_scope text, p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
    DELETE FROM auth_attempts WHERE scope = p_scope AND key = p_key
$$;

-- ---------------------------------------------------------------------------------------------
-- Вход и регистрация
-- ---------------------------------------------------------------------------------------------
-- Учётные данные для входа. Пароль проверяет приложение (bcrypt); приложению хэш напрямую недоступен.
CREATE FUNCTION fn_web_user_by_email(p_email citext)
RETURNS TABLE (o_id bigint, o_password_hash text, o_status user_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
    SELECT u.id, u.password_hash, u.status FROM users u WHERE u.email = p_email
$$;

-- Регистрация: пользователь с ролью client, нулевым балансом и неподтверждённым email + токен подтверждения.
-- Повтор email — SQLSTATE 23505, его приложение превращает в 409.
CREATE FUNCTION fn_web_register(p_email text, p_password_hash text, p_full_name text,
                                p_token_hash bytea, p_token_ttl_seconds integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_id bigint;
BEGIN
    INSERT INTO users (email, password_hash, full_name) VALUES (p_email, p_password_hash, p_full_name)
    RETURNING id INTO v_id;
    INSERT INTO email_tokens (user_id, token_hash, expires_at)
    VALUES (v_id, p_token_hash, now() + make_interval(secs => p_token_ttl_seconds));
    RETURN v_id;
END
$$;

CREATE FUNCTION fn_web_email_token_create(p_token_hash bytea, p_token_ttl_seconds integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user bigint := fn_app_user_id();
    v_verified timestamptz;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'user context required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT u.email_verified_at INTO v_verified FROM users u WHERE u.id = v_user;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user % not found', v_user USING ERRCODE = 'GR004';
    END IF;
    IF v_verified IS NOT NULL THEN
        RAISE EXCEPTION 'email of user % is already verified', v_user USING ERRCODE = 'GR003';
    END IF;
    -- старые неиспользованные ссылки перестают работать
    DELETE FROM email_tokens WHERE user_id = v_user AND used_at IS NULL;
    INSERT INTO email_tokens (user_id, token_hash, expires_at)
    VALUES (v_user, p_token_hash, now() + make_interval(secs => p_token_ttl_seconds));
END
$$;

-- Подтверждение по токену. NULL — токен неизвестен, просрочен или уже использован.
CREATE FUNCTION fn_web_verify_email(p_token_hash bytea) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user bigint;
BEGIN
    UPDATE email_tokens SET used_at = now()
     WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
    RETURNING user_id INTO v_user;
    IF v_user IS NULL THEN
        RETURN NULL;
    END IF;
    UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = v_user;
    RETURN v_user;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Сессии
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_session_create(p_user_id bigint, p_token_hash bytea, p_ttl_seconds integer,
                                  p_ip inet, p_user_agent text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_status  user_status;
    v_expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
BEGIN
    SELECT u.status INTO v_status FROM users u WHERE u.id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'GR004';
    END IF;
    IF v_status <> 'active' THEN
        RAISE EXCEPTION 'user % is blocked', p_user_id USING ERRCODE = 'GR003';
    END IF;
    INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
    VALUES (p_user_id, p_token_hash, v_expires, p_ip, left(p_user_agent, 300));
    RETURN v_expires;
END
$$;

-- Пользователь по токену сессии. Срок продлевается (скользящая сессия), но не чаще раза в p_renew_after_seconds:
-- иначе каждый GET превращался бы в запись в БД. o_renewed = true — приложению пора переслать cookie заново.
CREATE FUNCTION fn_session_resolve(p_token_hash bytea, p_ttl_seconds integer, p_renew_after_seconds integer DEFAULT 600)
RETURNS TABLE (o_user_id bigint, o_email text, o_full_name text, o_role user_role, o_status user_status,
               o_balance numeric, o_email_verified_at timestamptz, o_renewed boolean, o_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_sid     bigint;
    v_user    bigint;
    v_seen    timestamptz;
    v_expires timestamptz;
    v_renewed boolean := false;
    v_now     timestamptz := clock_timestamp();
BEGIN
    SELECT s.id, s.user_id, s.last_seen_at, s.expires_at INTO v_sid, v_user, v_seen, v_expires
    FROM sessions s WHERE s.token_hash = p_token_hash AND s.expires_at > v_now;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF v_seen < v_now - make_interval(secs => p_renew_after_seconds) THEN
        v_expires := v_now + make_interval(secs => p_ttl_seconds);
        UPDATE sessions SET last_seen_at = v_now, expires_at = v_expires WHERE id = v_sid;
        v_renewed := true;
    END IF;
    RETURN QUERY
    SELECT u.id, u.email::text, u.full_name, u.role, u.status, u.balance, u.email_verified_at, v_renewed, v_expires
    FROM users u WHERE u.id = v_user;
END
$$;

CREATE FUNCTION fn_session_delete(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
    DELETE FROM sessions WHERE token_hash = p_token_hash
$$;

-- Смена пароля. Текущий хэш приложение берёт здесь же (из своего контекста), сравнивает с введённым паролем
-- и передаёт новый. Все сессии пользователя удаляются, взамен создаётся новая для текущего браузера
-- (токен меняется: старый, возможно украденный, перестаёт действовать).
CREATE FUNCTION fn_web_password_hash() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_hash text;
BEGIN
    IF fn_app_user_id() IS NULL THEN
        RAISE EXCEPTION 'user context required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT u.password_hash INTO v_hash FROM users u WHERE u.id = fn_app_user_id();
    RETURN v_hash;
END
$$;

CREATE FUNCTION fn_web_set_password(p_new_hash text, p_token_hash bytea, p_ttl_seconds integer,
                                    p_ip inet, p_user_agent text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user    bigint := fn_app_user_id();
    v_expires timestamptz := now() + make_interval(secs => p_ttl_seconds);
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'user context required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE users SET password_hash = p_new_hash WHERE id = v_user;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user % not found', v_user USING ERRCODE = 'GR004';
    END IF;
    DELETE FROM sessions WHERE user_id = v_user;
    INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
    VALUES (v_user, p_token_hash, v_expires, p_ip, left(p_user_agent, 300));
    INSERT INTO audit_log (actor_user_id, action, entity, entity_id, ip)
    VALUES (v_user, 'user.password_changed', 'users', v_user::text, _fn_audit_ip());
    RETURN v_expires;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- API-ключи: у api_keys есть RLS по app.user_id, но до проверки ключа пользователь неизвестен, поэтому
-- поиск по хэшу вынесен в узкую функцию. Отозванный и просроченный ключ не находится.
-- last_used_at обновляется не чаще раза в минуту.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_find_api_key(p_key_hash bytea)
RETURNS TABLE (o_key_id bigint, o_user_id bigint, o_email text, o_full_name text, o_role user_role,
               o_status user_status, o_balance numeric, o_email_verified_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_key  bigint;
    v_user bigint;
BEGIN
    SELECT k.id, k.user_id INTO v_key, v_user
    FROM api_keys k
    WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now());
    IF NOT FOUND THEN
        RETURN;
    END IF;
    UPDATE api_keys SET last_used_at = now()
     WHERE id = v_key AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
    RETURN QUERY
    SELECT v_key, u.id, u.email::text, u.full_name, u.role, u.status, u.balance, u.email_verified_at
    FROM users u WHERE u.id = v_user;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Биллинг «при обращении» (serverless: постоянного процесса нет, планировщик редкий).
-- Начисляет ТОЛЬКО пользователю из app.user_id и только за интервалы длиннее минуты (иначе опрос интерфейса
-- плодил бы по записи потребления на каждый GET). Тело цикла повторяет fn_bill_usage для одного пользователя,
-- но блокировку пользователя ждёт (FOR UPDATE), а не пропускает: человек, открывший страницу, должен увидеть
-- честный баланс. Использует те же внутренние функции _fn_bill_instance, _fn_bill_volume, _fn_halt_instance.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_bill_current_user(OUT o_usage_rows integer, OUT o_amount numeric, OUT o_stopped integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user    bigint := fn_app_user_id();
    v_cutoff  timestamptz;
    v_min     interval := interval '1 minute';
    r         record;
    v_charged numeric;
BEGIN
    o_usage_rows := 0; o_amount := 0; o_stopped := 0;
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'user context required' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- без блокировок выясняем, есть ли что начислять: большинство обращений на этом и заканчивается
    IF NOT EXISTS (SELECT 1 FROM instances i WHERE i.user_id = v_user AND i.status = 'running'
                                               AND i.last_billed_at < clock_timestamp() - v_min)
       AND NOT EXISTS (SELECT 1 FROM volumes v WHERE v.user_id = v_user
                       AND ((v.status = 'active'  AND v.last_billed_at < clock_timestamp() - v_min)
                         OR (v.status = 'deleted' AND v.last_billed_at < v.deleted_at)))
    THEN
        RETURN;
    END IF;

    PERFORM 1 FROM users u WHERE u.id = v_user FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    v_cutoff := clock_timestamp();   -- после блокировки, как в fn_bill_usage

    FOR r IN
        SELECT i.id FROM instances i
        WHERE i.user_id = v_user AND i.status = 'running' AND i.last_billed_at < v_cutoff - v_min
        ORDER BY i.id FOR UPDATE
    LOOP
        v_charged := _fn_bill_instance(r.id, v_cutoff);
        IF v_charged > 0 THEN
            o_usage_rows := o_usage_rows + 1;
            o_amount := o_amount + v_charged;
        END IF;
    END LOOP;

    FOR r IN
        SELECT v.id FROM volumes v
        WHERE v.user_id = v_user
          AND ((v.status = 'active' AND v.last_billed_at < v_cutoff - v_min)
            OR (v.status = 'deleted' AND v.last_billed_at < v.deleted_at))
        ORDER BY v.id FOR UPDATE
    LOOP
        v_charged := _fn_bill_volume(r.id, v_cutoff);
        IF v_charged > 0 THEN
            o_usage_rows := o_usage_rows + 1;
            o_amount := o_amount + v_charged;
        END IF;
    END LOOP;

    IF (SELECT u.balance FROM users u WHERE u.id = v_user) <= 0 THEN
        FOR r IN
            SELECT i.id FROM instances i
            WHERE i.user_id = v_user AND i.status = 'running'
            ORDER BY i.id FOR UPDATE
        LOOP
            PERFORM _fn_halt_instance(r.id, v_cutoff, 'stopped');
            INSERT INTO audit_log (action, entity, entity_id, details)
            VALUES ('instance.autostop_low_balance', 'instances', r.id::text,
                    jsonb_build_object('user_id', v_user, 'cutoff', v_cutoff));
            o_stopped := o_stopped + 1;
        END LOOP;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Платёжный шлюз: уведомление о статусе платежа. Подпись проверяет приложение; здесь — поиск платежа,
-- сверка суммы и идемпотентное зачисление через fn_topup. Только системный контекст.
-- RLS не даёт системному контексту видеть чужие платежи, поэтому поиск вынесен в функцию.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_payment_confirm(p_provider text, p_provider_payment_id text, p_status text, p_amount numeric,
                                   OUT o_payment_id bigint, OUT o_user_id bigint,
                                   OUT o_status payment_status, OUT o_credited boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_amount numeric;
BEGIN
    PERFORM _fn_assert_system();
    IF p_status NOT IN ('succeeded', 'failed') THEN
        RAISE EXCEPTION 'unsupported payment status %', p_status USING ERRCODE = 'GR005';
    END IF;

    SELECT p.id, p.user_id, p.amount INTO o_payment_id, o_user_id, v_amount
    FROM payments p WHERE p.provider = p_provider AND p.provider_payment_id = p_provider_payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment % / % not found', p_provider, p_provider_payment_id USING ERRCODE = 'GR004';
    END IF;
    IF p_amount IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'amount % does not match payment %', p_amount, o_payment_id USING ERRCODE = 'GR005';
    END IF;

    o_credited := false;
    IF p_status = 'succeeded' THEN
        o_credited := fn_topup(o_payment_id);   -- pending -> succeeded + зачисление; повтор вернёт false
    ELSE
        PERFORM 1 FROM users u WHERE u.id = o_user_id FOR UPDATE;
        UPDATE payments SET status = 'failed' WHERE id = o_payment_id AND status = 'pending';
        IF (SELECT p.status FROM payments p WHERE p.id = o_payment_id) NOT IN ('failed') THEN
            RAISE EXCEPTION 'payment % is already %', o_payment_id,
                (SELECT p.status FROM payments p WHERE p.id = o_payment_id) USING ERRCODE = 'GR003';
        END IF;
    END IF;
    SELECT p.status INTO o_status FROM payments p WHERE p.id = o_payment_id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Администрирование: блокировка пользователей. UPDATE users приложению больше не выдан (см. ниже),
-- поэтому смена статуса возможна только через эту функцию и только для администратора.
-- Журнал аудита пишет существующий триггер trg_audit_users (actor = app.user_id).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_admin_set_user_status(p_user_id bigint, p_status user_status) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF NOT fn_app_is_admin() THEN
        RAISE EXCEPTION 'admin context required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_user_id = fn_app_user_id() THEN
        RAISE EXCEPTION 'administrator cannot change own status' USING ERRCODE = 'GR003';
    END IF;
    UPDATE users SET status = p_status WHERE id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'GR004';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Обслуживание: журнал проходов биллинга и очистка. Только системный контекст (cron).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_billing_run_done(p_details jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    PERFORM _fn_assert_system();
    INSERT INTO billing_runs (details) VALUES (coalesce(p_details, '{}'));
END
$$;

-- Без проверки контекста: отдаёт только момент последнего прохода (для health-check без входа).
CREATE FUNCTION fn_last_billing_at() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
    SELECT max(finished_at) FROM billing_runs
$$;

CREATE FUNCTION fn_web_cleanup(OUT o_sessions integer, OUT o_attempts integer, OUT o_tokens integer, OUT o_runs integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    PERFORM _fn_assert_system();
    DELETE FROM sessions WHERE expires_at < now();
    GET DIAGNOSTICS o_sessions = ROW_COUNT;
    DELETE FROM auth_attempts WHERE created_at < now() - interval '1 day';
    GET DIAGNOSTICS o_attempts = ROW_COUNT;
    DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days' OR used_at < now() - interval '7 days';
    GET DIAGNOSTICS o_tokens = ROW_COUNT;
    DELETE FROM billing_runs WHERE finished_at < now() - interval '90 days';
    GET DIAGNOSTICS o_runs = ROW_COUNT;
END
$$;

COMMENT ON FUNCTION fn_auth_throttle_hit(text, text, integer, integer) IS
    'Ограничение частоты: 0 — попытка записана, N > 0 — лимит исчерпан, повторить через N секунд.';
COMMENT ON FUNCTION fn_session_resolve(bytea, integer, integer) IS
    'Пользователь по хэшу токена сессии; продлевает срок не чаще раза в p_renew_after_seconds (o_renewed).';
COMMENT ON FUNCTION fn_find_api_key(bytea) IS
    'Поиск действующего API-ключа по SHA-256 (RLS api_keys не знает пользователя до проверки ключа).';
COMMENT ON FUNCTION fn_bill_current_user() IS
    'Биллинг при обращении: начисляет только пользователю app.user_id за интервалы длиннее минуты, ждёт его блокировку.';
COMMENT ON FUNCTION fn_payment_confirm(text, text, text, numeric) IS
    'Уведомление шлюза: сверка суммы и идемпотентное зачисление (fn_topup). Только системный контекст.';
COMMENT ON FUNCTION fn_admin_set_user_status(bigint, user_status) IS
    'Блокировка/разблокировка пользователя; только администратор, себя блокировать нельзя.';
COMMENT ON FUNCTION fn_web_cleanup() IS 'Удаляет просроченные сессии, старые попытки входа, токены email и записи billing_runs старше 90 суток.';

-- ---------------------------------------------------------------------------------------------
-- Права. Новые функции — только gpu_rent_app (REVOKE FROM PUBLIC явный, хотя ALTER DEFAULT PRIVILEGES уже сделал это).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        WHERE p.pronamespace = 'gpu_rent'::regnamespace
          AND p.proowner = 'gpu_rent_owner'::regrole
          AND (p.proname IN ('fn_auth_throttle_hit', 'fn_auth_throttle_clear', 'fn_web_user_by_email', 'fn_web_register',
                             'fn_web_email_token_create', 'fn_web_verify_email', 'fn_session_create', 'fn_session_resolve',
                             'fn_session_delete', 'fn_web_password_hash', 'fn_web_set_password', 'fn_find_api_key',
                             'fn_bill_current_user', 'fn_payment_confirm', 'fn_admin_set_user_status',
                             'fn_billing_run_done', 'fn_last_billing_at', 'fn_web_cleanup'))
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO gpu_rent_app', f.sig);
    END LOOP;
END
$$;

-- Хэш пароля и роль пользователя приложению напрямую не нужны (вход, регистрация и смена пароля идут через
-- функции выше), поэтому SELECT сужается до безопасных столбцов, а INSERT/UPDATE на users снимаются целиком.
-- REVOKE на уровне таблицы убирает и ранее выданные права на отдельные столбцы.
REVOKE SELECT, INSERT, UPDATE ON users FROM gpu_rent_app;
GRANT SELECT (id, email, full_name, role, status, balance, email_verified_at, created_at, updated_at)
    ON users TO gpu_rent_app;

-- RLS: клиент видит только свою строку, администратор — все. До входа (нет app.user_id) строк нет.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_users ON users FOR SELECT TO gpu_rent_app
    USING (id = fn_app_user_id() OR fn_app_is_admin());

-- Шаблоны: публичные видят все, приватные — владелец и администратор; менять и удалять можно только своё
-- (публичные, у которых owner_id IS NULL, — только администратор).
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_templates_select ON templates FOR SELECT TO gpu_rent_app
    USING (is_public OR owner_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_templates_insert ON templates FOR INSERT TO gpu_rent_app
    WITH CHECK (owner_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_templates_update ON templates FOR UPDATE TO gpu_rent_app
    USING (owner_id = fn_app_user_id() OR fn_app_is_admin())
    WITH CHECK (owner_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_templates_delete ON templates FOR DELETE TO gpu_rent_app
    USING (owner_id = fn_app_user_id() OR fn_app_is_admin());

INSERT INTO schema_migrations (version) VALUES ('0013_web_auth');
COMMIT;

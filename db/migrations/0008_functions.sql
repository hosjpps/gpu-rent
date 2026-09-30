-- 0008: бизнес-функции: запуск/остановка/терминация инстансов, биллинг, пополнение, секреты env.
--
-- Правила, общие для всех функций (первоначальный проект, П3):
--   * порядок блокировок: сначала строка users (FOR UPDATE), затем ресурсы пользователя
--     (инстансы, тома, платежи); строки GPU берутся только через SKIP LOCKED, поэтому
--     взаимоблокировок между пользователями быть не может;
--   * last_billed_at читается уже ПОСЛЕ блокировки пользователя, граница биллинга не идёт назад;
--   * SECURITY DEFINER + фиксированный search_path; право вызова — только у gpu_rent_app (0011);
--   * контекст вызывающего приходит через set_config('app.user_id' / 'app.user_role', ..., true).
--
-- Коды ошибок (SQLSTATE), по которым бэкенд различает причины:
--   GR001 не хватает свободных GPU      GR002 недостаточно средств
--   GR003 недопустимое состояние        GR004 объект или цена не найдены
--   GR005 нарушена согласованность      GR006 не задан ключ app.enc_key
--   42501 вызывающий не вправе действовать от имени этого пользователя
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

-- ---------------------------------------------------------------------------------------------
-- Контекст приложения. Эти две функции вызываются из политик RLS, поэтому они простые SQL
-- (PostgreSQL подставляет их тело в запрос) и без SET search_path: используют только pg_catalog.
-- current_setting(..., true) не падает, если контекст не выставлен: строк просто нет.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_app_user_id() RETURNS bigint
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::bigint $$;

CREATE FUNCTION fn_app_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.user_role', true) = 'admin', false) $$;

COMMENT ON FUNCTION fn_app_user_id() IS 'Пользователь из контекста сессии (app.user_id) или NULL.';
COMMENT ON FUNCTION fn_app_is_admin() IS 'true, если app.user_role = admin. Используется политиками RLS.';

-- Привилегированный контекст: администратор или системный (планировщик биллинга, webhook шлюза).
CREATE FUNCTION _fn_assert_system() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF coalesce(current_setting('app.user_role', true) IN ('admin', 'system'), false) IS NOT TRUE THEN
        RAISE EXCEPTION 'system or admin context required' USING ERRCODE = 'insufficient_privilege';
    END IF;
END
$$;

-- Можно ли действовать от имени p_user_id: сам пользователь либо привилегированный контекст.
-- coalesce нужен потому, что при пустом контексте выражение даёт NULL, а IF NULL не срабатывает.
CREATE FUNCTION _fn_assert_actor(p_user_id bigint) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF NOT coalesce(current_setting('app.user_role', true) IN ('admin', 'system')
                    OR fn_app_user_id() = p_user_id, false) THEN
        RAISE EXCEPTION 'not allowed to act for user %', p_user_id USING ERRCODE = 'insufficient_privilege';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Подбор GPU: ровно p_gpu_count свободных GPU одной online-ноды нужного ДЦ и модели.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION _fn_alloc_gpus(p_datacenter_id bigint, p_gpu_model_id bigint, p_gpu_count integer,
                               OUT o_node_id bigint, OUT o_gpu_ids bigint[])
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_node bigint;
    v_ids  bigint[];
BEGIN
    -- Кандидаты — ноды, где по снимку свободно достаточно GPU. Порядок «меньше всего свободных первыми»
    -- (best fit): мелкие запросы добивают начатые ноды, целые ноды остаются для 8-GPU запросов.
    FOR v_node IN
        SELECT n.id
        FROM nodes n
        JOIN gpus g ON g.node_id = n.id AND g.gpu_model_id = p_gpu_model_id AND g.is_enabled
        WHERE n.datacenter_id = p_datacenter_id
          AND n.status = 'online'
          AND NOT EXISTS (SELECT 1 FROM instance_gpus ig
                          WHERE ig.gpu_id = g.id AND upper_inf(ig.allocated_during))
        GROUP BY n.id
        HAVING count(*) >= p_gpu_count
        ORDER BY count(*), n.id
    LOOP
        -- Блокируем строки самих GPU. SKIP LOCKED: GPU, которую прямо сейчас берёт другая
        -- транзакция, пропускаем, а не ждём — два запуска не выберут одну и ту же GPU и не зависнут.
        -- Если из-за пропусков набралось меньше нужного, переходим к следующей ноде.
        SELECT array_agg(s.id) INTO v_ids
        FROM (
            SELECT g.id
            FROM gpus g
            WHERE g.node_id = v_node AND g.gpu_model_id = p_gpu_model_id AND g.is_enabled
              AND NOT EXISTS (SELECT 1 FROM instance_gpus ig
                              WHERE ig.gpu_id = g.id AND upper_inf(ig.allocated_during))
            ORDER BY g.slot_index
            LIMIT p_gpu_count
            FOR UPDATE OF g SKIP LOCKED
        ) s;

        -- Повторная проверка уже под блокировками: запрос выше мог взять GPU, которую конкурент успел
        -- закоммитить между снимком и блокировкой; новый оператор видит свежие данные (READ COMMITTED).
        IF cardinality(v_ids) = p_gpu_count
           AND NOT EXISTS (SELECT 1 FROM instance_gpus ig
                           WHERE ig.gpu_id = ANY (v_ids) AND upper_inf(ig.allocated_during)) THEN
            o_node_id := v_node;
            o_gpu_ids := v_ids;
            RETURN;
        END IF;
    END LOOP;

    -- Если и после этого возникнет наложение, последняя линия обороны — EXCLUDE (23P01) на instance_gpus.
    RAISE EXCEPTION 'not enough free GPUs (datacenter %, model %, need %)',
        p_datacenter_id, p_gpu_model_id, p_gpu_count USING ERRCODE = 'GR001';
END
$$;

-- Цена запуска за весь инстанс (цена GPU * число GPU) на момент p_at + проверка «баланс >= 1 часа» (FR-07).
-- Вызывается только при удержанной блокировке пользователя: иначе баланс мог бы измениться между проверкой и запуском.
CREATE FUNCTION _fn_quote_instance(p_user_id bigint, p_datacenter_id bigint, p_gpu_model_id bigint,
                                   p_gpu_count integer, p_pricing_type pricing_type, p_at timestamptz)
RETURNS numeric
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_price numeric;
    v_total numeric;
BEGIN
    SELECT gp.price_per_hour INTO v_price
    FROM gpu_prices gp
    WHERE gp.datacenter_id = p_datacenter_id AND gp.gpu_model_id = p_gpu_model_id
      AND gp.pricing_type = p_pricing_type AND gp.valid_during @> p_at;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no active % price for datacenter %, model %', p_pricing_type, p_datacenter_id, p_gpu_model_id
            USING ERRCODE = 'GR004';
    END IF;

    v_total := v_price * p_gpu_count;
    IF (SELECT u.balance FROM users u WHERE u.id = p_user_id) < v_total THEN
        RAISE EXCEPTION 'insufficient balance: need at least % for one hour', v_total USING ERRCODE = 'GR002';
    END IF;
    RETURN v_total;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Списание за интервал [last_billed_at, p_until) для одного инстанса. Возвращает сумму (0 — ничего).
-- Вызывающий уже держит блокировку пользователя. usage_records и charge пишутся одним вызовом,
-- то есть в одной транзакции: потребление без списания (и наоборот) возникнуть не может.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION _fn_bill_instance(p_instance_id uuid, p_until timestamptz) RETURNS numeric
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    r             record;
    v_seconds     numeric;
    v_amount      numeric;
    v_usage_id    bigint;
    v_usage_start timestamptz;
BEGIN
    SELECT i.user_id, i.name, i.price_per_hour_snapshot, i.last_billed_at INTO r
    FROM instances i
    WHERE i.id = p_instance_id AND i.status = 'running'
    FOR UPDATE;

    -- Граница не двигается назад: повторный проход на тот же (или более ранний) момент ничего не делает.
    IF NOT FOUND OR p_until <= r.last_billed_at THEN
        RETURN 0;
    END IF;

    v_seconds := extract(epoch FROM p_until - r.last_billed_at);
    v_amount  := round(r.price_per_hour_snapshot * v_seconds / 3600, 4);
    -- Интервал настолько короткий, что стоит меньше 0,0001 ₽: границу не двигаем, время доначислится позже.
    IF v_amount = 0 THEN
        RETURN 0;
    END IF;

    INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount)
    VALUES (r.user_id, p_instance_id, 'gpu', r.last_billed_at, p_until, v_seconds, v_amount)
    RETURNING id, period_start INTO v_usage_id, v_usage_start;

    INSERT INTO transactions (user_id, type, amount, usage_id, usage_period_start, description, created_at)
    VALUES (r.user_id, 'charge', -v_amount, v_usage_id, v_usage_start, 'GPU-инстанс ' || r.name, p_until);

    UPDATE instances SET last_billed_at = p_until WHERE id = p_instance_id;
    RETURN v_amount;
END
$$;

-- То же для тома. Цена — по тарифу ДЦ на конец интервала; 1 месяц = 30 суток = 2 592 000 с.
-- Удалённый том дотарифицируется до deleted_at и дальше не начисляется.
CREATE FUNCTION _fn_bill_volume(p_volume_id bigint, p_until timestamptz) RETURNS numeric
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    r             record;
    v_end         timestamptz;
    v_price       numeric;
    v_quantity    numeric;
    v_amount      numeric;
    v_usage_id    bigint;
    v_usage_start timestamptz;
BEGIN
    SELECT v.user_id, v.name, v.datacenter_id, v.size_gb, v.last_billed_at, v.deleted_at INTO r
    FROM volumes v
    WHERE v.id = p_volume_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    v_end := least(p_until, coalesce(r.deleted_at, p_until));
    IF v_end <= r.last_billed_at THEN
        RETURN 0;
    END IF;

    SELECT sp.price_per_gb_month INTO v_price
    FROM storage_prices sp
    WHERE sp.datacenter_id = r.datacenter_id AND sp.valid_during @> v_end;
    IF NOT FOUND THEN
        -- Не роняем проход для всех пользователей из-за отсутствующего тарифа: том доначислится, когда цена появится.
        RAISE WARNING 'no storage price for datacenter % at %, volume % is not billed',
            r.datacenter_id, v_end, p_volume_id;
        RETURN 0;
    END IF;

    v_quantity := r.size_gb * extract(epoch FROM v_end - r.last_billed_at);   -- ГБ·с
    v_amount   := round(v_quantity * v_price / 2592000, 4);
    IF v_amount = 0 THEN
        RETURN 0;
    END IF;

    INSERT INTO usage_records (user_id, volume_id, kind, period_start, period_end, quantity, amount)
    VALUES (r.user_id, p_volume_id, 'storage', r.last_billed_at, v_end, v_quantity, v_amount)
    RETURNING id, period_start INTO v_usage_id, v_usage_start;

    INSERT INTO transactions (user_id, type, amount, usage_id, usage_period_start, description, created_at)
    VALUES (r.user_id, 'charge', -v_amount, v_usage_id, v_usage_start, 'Том ' || r.name, v_end);

    UPDATE volumes SET last_billed_at = v_end WHERE id = p_volume_id;
    RETURN v_amount;
END
$$;

-- Остановка или терминация работающего (или простаивающего) инстанса в момент p_at.
-- Порядок такой: сначала дотарифицировать интервал до p_at, затем закрыть аллокации GPU.
CREATE FUNCTION _fn_halt_instance(p_instance_id uuid, p_at timestamptz, p_new_status instance_status)
RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_status instance_status;
    v_billed timestamptz;
    v_at     timestamptz := p_at;
BEGIN
    SELECT i.status, i.last_billed_at INTO v_status, v_billed
    FROM instances i WHERE i.id = p_instance_id FOR UPDATE;

    IF v_status = 'running' THEN
        -- остановка не может быть раньше уже учтённого момента
        v_at := greatest(p_at, v_billed);
        PERFORM _fn_bill_instance(p_instance_id, v_at);
        -- +1 мкс: диапазон не должен вырождаться в пустой (CHECK ck_instance_gpus_range)
        UPDATE instance_gpus
           SET allocated_during = tstzrange(lower(allocated_during),
                                            greatest(v_at, lower(allocated_during) + interval '1 microsecond'), '[)')
         WHERE instance_id = p_instance_id AND upper_inf(allocated_during);
    END IF;

    UPDATE instances
       SET status        = p_new_status,
           stopped_at    = CASE WHEN status = 'running' THEN v_at ELSE stopped_at END,
           terminated_at = CASE WHEN p_new_status = 'terminated' THEN v_at END
     WHERE id = p_instance_id;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Публичные функции жизненного цикла (FR-07, FR-08).
-- ---------------------------------------------------------------------------------------------

-- Создаёт и сразу запускает инстанс: проверки -> снимок цены -> подбор GPU -> аллокация.
-- Состояние pending не используется: запуск на ноде считаем мгновенным, биллинг идёт с момента выделения GPU.
CREATE FUNCTION fn_start_instance(
    p_user_id           bigint,
    p_datacenter_id     bigint,
    p_gpu_model_id      bigint,
    p_gpu_count         integer,
    p_pricing_type      pricing_type,
    p_template_id       bigint,
    p_name              text,
    p_container_disk_gb integer DEFAULT NULL,
    p_volume_id         bigint  DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_status  user_status;
    v_now          timestamptz;
    v_default_disk integer;
    v_volume_dc    bigint;
    v_total        numeric;
    v_node         bigint;
    v_gpu_ids      bigint[];
    v_id           uuid;
BEGIN
    PERFORM _fn_assert_actor(p_user_id);
    IF p_gpu_count NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION 'gpu_count must be between 1 and 8' USING ERRCODE = 'GR005';
    END IF;

    SELECT u.status INTO v_user_status FROM users u WHERE u.id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'GR004';
    END IF;
    IF v_user_status <> 'active' THEN
        RAISE EXCEPTION 'user % is blocked', p_user_id USING ERRCODE = 'GR003';
    END IF;

    v_now := clock_timestamp();

    IF NOT EXISTS (SELECT 1 FROM datacenters d WHERE d.id = p_datacenter_id AND d.is_active) THEN
        RAISE EXCEPTION 'datacenter % not found or inactive', p_datacenter_id USING ERRCODE = 'GR004';
    END IF;

    SELECT t.default_disk_gb INTO v_default_disk
    FROM templates t
    WHERE t.id = p_template_id AND (t.is_public OR t.owner_id = p_user_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'template % not found', p_template_id USING ERRCODE = 'GR004';
    END IF;

    IF p_volume_id IS NOT NULL THEN
        SELECT v.datacenter_id INTO v_volume_dc
        FROM volumes v
        WHERE v.id = p_volume_id AND v.user_id = p_user_id AND v.status = 'active'
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'volume % not found', p_volume_id USING ERRCODE = 'GR004';
        END IF;
        IF v_volume_dc <> p_datacenter_id THEN
            RAISE EXCEPTION 'volume % is in another datacenter', p_volume_id USING ERRCODE = 'GR005';
        END IF;
        IF EXISTS (SELECT 1 FROM instances i
                   WHERE i.volume_id = p_volume_id AND i.status IN ('pending', 'running', 'stopped')) THEN
            RAISE EXCEPTION 'volume % is already attached to a live instance', p_volume_id USING ERRCODE = 'GR003';
        END IF;
    END IF;

    v_total := _fn_quote_instance(p_user_id, p_datacenter_id, p_gpu_model_id, p_gpu_count, p_pricing_type, v_now);

    SELECT a.o_node_id, a.o_gpu_ids INTO v_node, v_gpu_ids
    FROM _fn_alloc_gpus(p_datacenter_id, p_gpu_model_id, p_gpu_count) a;

    -- Момент старта берётся после подбора: видимое закрытие прежней аллокации этой GPU (её upper = момент
    -- остановки в другой транзакции) уже в прошлом, иначе новый диапазон мог бы пересечь закрытый (23P01).
    v_now := clock_timestamp();

    INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, volume_id, name, pricing_type,
                           gpu_count, container_disk_gb, price_per_hour_snapshot, status,
                           created_at, started_at, last_billed_at)
    VALUES (p_user_id, v_node, p_gpu_model_id, p_template_id, p_volume_id, p_name, p_pricing_type,
            p_gpu_count, coalesce(p_container_disk_gb, v_default_disk), v_total, 'running',
            v_now, v_now, v_now)
    RETURNING id INTO v_id;

    INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during)
    SELECT v_id, g, tstzrange(v_now, NULL, '[)') FROM unnest(v_gpu_ids) AS g;

    RETURN v_id;
END
$$;

-- Повторный запуск остановленного инстанса (stopped -> running): новый подбор GPU в том же ДЦ,
-- новый снимок цены, last_billed_at сбрасывается на момент старта.
CREATE FUNCTION fn_resume_instance(p_instance_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_id     bigint;
    v_user_status user_status;
    r             record;
    v_now         timestamptz;
    v_total       numeric;
    v_node        bigint;
    v_gpu_ids     bigint[];
BEGIN
    SELECT i.user_id INTO v_user_id FROM instances i WHERE i.id = p_instance_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'instance % not found', p_instance_id USING ERRCODE = 'GR004';
    END IF;
    PERFORM _fn_assert_actor(v_user_id);

    SELECT u.status INTO v_user_status FROM users u WHERE u.id = v_user_id FOR UPDATE;
    IF v_user_status <> 'active' THEN
        RAISE EXCEPTION 'user % is blocked', v_user_id USING ERRCODE = 'GR003';
    END IF;

    SELECT i.status, i.gpu_model_id, i.gpu_count, i.pricing_type, n.datacenter_id INTO r
    FROM instances i JOIN nodes n ON n.id = i.node_id
    WHERE i.id = p_instance_id
    FOR UPDATE OF i;
    IF r.status <> 'stopped' THEN
        RAISE EXCEPTION 'instance % is %, only stopped instances can be resumed', p_instance_id, r.status
            USING ERRCODE = 'GR003';
    END IF;

    v_now   := clock_timestamp();
    v_total := _fn_quote_instance(v_user_id, r.datacenter_id, r.gpu_model_id, r.gpu_count, r.pricing_type, v_now);

    SELECT a.o_node_id, a.o_gpu_ids INTO v_node, v_gpu_ids
    FROM _fn_alloc_gpus(r.datacenter_id, r.gpu_model_id, r.gpu_count) a;

    -- Момент старта берётся после подбора: видимое закрытие прежней аллокации этой GPU (её upper = момент
    -- остановки в другой транзакции) уже в прошлом, иначе новый диапазон мог бы пересечь закрытый (23P01).
    v_now := clock_timestamp();

    UPDATE instances
       SET node_id = v_node, status = 'running', price_per_hour_snapshot = v_total,
           started_at = v_now, stopped_at = NULL, last_billed_at = v_now
     WHERE id = p_instance_id;

    INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during)
    SELECT p_instance_id, g, tstzrange(v_now, NULL, '[)') FROM unnest(v_gpu_ids) AS g;
END
$$;

CREATE FUNCTION fn_stop_instance(p_instance_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_id bigint;
    v_status  instance_status;
BEGIN
    SELECT i.user_id INTO v_user_id FROM instances i WHERE i.id = p_instance_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'instance % not found', p_instance_id USING ERRCODE = 'GR004';
    END IF;
    PERFORM _fn_assert_actor(v_user_id);

    PERFORM 1 FROM users u WHERE u.id = v_user_id FOR UPDATE;
    SELECT i.status INTO v_status FROM instances i WHERE i.id = p_instance_id FOR UPDATE;
    IF v_status <> 'running' THEN
        RAISE EXCEPTION 'instance % is %, only running instances can be stopped', p_instance_id, v_status
            USING ERRCODE = 'GR003';
    END IF;

    PERFORM _fn_halt_instance(p_instance_id, clock_timestamp(), 'stopped');
END
$$;

CREATE FUNCTION fn_terminate_instance(p_instance_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_id bigint;
    v_status  instance_status;
BEGIN
    SELECT i.user_id INTO v_user_id FROM instances i WHERE i.id = p_instance_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'instance % not found', p_instance_id USING ERRCODE = 'GR004';
    END IF;
    PERFORM _fn_assert_actor(v_user_id);

    PERFORM 1 FROM users u WHERE u.id = v_user_id FOR UPDATE;
    SELECT i.status INTO v_status FROM instances i WHERE i.id = p_instance_id FOR UPDATE;
    IF v_status = 'terminated' THEN
        RAISE EXCEPTION 'instance % is already terminated', p_instance_id USING ERRCODE = 'GR003';
    END IF;

    PERFORM _fn_halt_instance(p_instance_id, clock_timestamp(), 'terminated');
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Биллинг-проход (FR-10, FR-12). Вызывается планировщиком раз в минуту.
--   p_now     — граница учёта; NULL = clock_timestamp() после блокировки каждого пользователя;
--   p_user_id — провести только этого пользователя. Проход — одна транзакция, и блокировки всех обработанных
--               пользователей держатся до её конца; при большом числе пользователей планировщик вызывает функцию
--               по одному пользователю (короткие транзакции), а вызов без p_user_id подходит для малых нагрузок и тестов.
-- Пользователь, строка которого занята другой транзакцией (например, идёт его запуск), пропускается
-- (SKIP LOCKED) и будет списан следующим проходом: проход не зависает на чужих блокировках.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_bill_usage(p_now timestamptz DEFAULT NULL, p_user_id bigint DEFAULT NULL,
                              OUT o_users integer, OUT o_usage_rows integer,
                              OUT o_amount numeric, OUT o_stopped integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user    bigint;
    v_cutoff  timestamptz;
    r         record;
    v_charged numeric;
BEGIN
    PERFORM _fn_assert_system();
    o_users := 0; o_usage_rows := 0; o_amount := 0; o_stopped := 0;

    -- Кандидатов ищем без блокировок (дёшево, по partial-индексу), а все решения принимаем после блокировки.
    FOR v_user IN
        SELECT i.user_id FROM instances i
        WHERE i.status = 'running' AND i.last_billed_at < coalesce(p_now, clock_timestamp())
          AND (p_user_id IS NULL OR i.user_id = p_user_id)
        UNION
        SELECT v.user_id FROM volumes v
        WHERE ((v.status = 'active'  AND v.last_billed_at < coalesce(p_now, clock_timestamp()))
            OR (v.status = 'deleted' AND v.last_billed_at < v.deleted_at))
          AND (p_user_id IS NULL OR v.user_id = p_user_id)
        ORDER BY 1
    LOOP
        PERFORM 1 FROM users u WHERE u.id = v_user FOR UPDATE SKIP LOCKED;
        CONTINUE WHEN NOT FOUND;

        v_cutoff := coalesce(p_now, clock_timestamp());   -- после блокировки
        o_users  := o_users + 1;

        FOR r IN
            SELECT i.id FROM instances i
            WHERE i.user_id = v_user AND i.status = 'running' AND i.last_billed_at < v_cutoff
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
              AND ((v.status = 'active' AND v.last_billed_at < v_cutoff)
                OR (v.status = 'deleted' AND v.last_billed_at < v.deleted_at))
            ORDER BY v.id FOR UPDATE
        LOOP
            v_charged := _fn_bill_volume(r.id, v_cutoff);
            IF v_charged > 0 THEN
                o_usage_rows := o_usage_rows + 1;
                o_amount := o_amount + v_charged;
            END IF;
        END LOOP;

        -- Автостоп при балансе <= 0. Остановка в той же транзакции, что и списание: за долгом не остаётся «хвоста».
        IF (SELECT u.balance FROM users u WHERE u.id = v_user) <= 0 THEN
            FOR r IN
                SELECT i.id FROM instances i
                WHERE i.user_id = v_user AND i.status = 'running'
                ORDER BY i.id FOR UPDATE
            LOOP
                PERFORM _fn_halt_instance(r.id, v_cutoff, 'stopped');
                -- уведомление FR-12: запись, по которой бэкенд рассылает письмо/push
                INSERT INTO audit_log (action, entity, entity_id, details)
                VALUES ('instance.autostop_low_balance', 'instances', r.id::text,
                        jsonb_build_object('user_id', v_user, 'cutoff', v_cutoff));
                o_stopped := o_stopped + 1;
            END LOOP;
        END IF;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Пополнение баланса (FR-11). Идемпотентно по платежу: возвращает true, если зачислили сейчас,
-- и false, если платёж уже был зачтён. Гарантия — UNIQUE (payment_id) WHERE type = 'topup'.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_topup(p_payment_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_id bigint;
    v_status  payment_status;
    v_amount  numeric;
    v_rows    integer;
BEGIN
    PERFORM _fn_assert_system();

    SELECT p.user_id INTO v_user_id FROM payments p WHERE p.id = p_payment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'payment % not found', p_payment_id USING ERRCODE = 'GR004';
    END IF;

    PERFORM 1 FROM users u WHERE u.id = v_user_id FOR UPDATE;
    SELECT p.status, p.amount INTO v_status, v_amount FROM payments p WHERE p.id = p_payment_id FOR UPDATE;

    IF v_status = 'pending' THEN
        -- webhook шлюза подтвердил оплату
        UPDATE payments SET status = 'succeeded', paid_at = clock_timestamp() WHERE id = p_payment_id;
    ELSIF v_status <> 'succeeded' THEN
        RAISE EXCEPTION 'payment % is %, it cannot be credited', p_payment_id, v_status USING ERRCODE = 'GR003';
    END IF;

    INSERT INTO transactions (user_id, type, amount, payment_id, description)
    VALUES (v_user_id, 'topup', v_amount, p_payment_id, 'Пополнение баланса, платёж ' || p_payment_id)
    ON CONFLICT (payment_id) WHERE type = 'topup' DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    RETURN v_rows = 1;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Секреты env (NFR-03): ключ шифрования приходит из app.enc_key и в БД не хранится.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION _fn_enc_key() RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_key text := nullif(current_setting('app.enc_key', true), '');
BEGIN
    -- Пустой ключ молча зашифровал бы данные предсказуемым значением — поэтому явная ошибка.
    IF v_key IS NULL THEN
        RAISE EXCEPTION 'app.enc_key is not set' USING ERRCODE = 'GR006';
    END IF;
    RETURN v_key;
END
$$;

CREATE FUNCTION fn_env_set(p_instance_id uuid, p_name text, p_value text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_id bigint;
BEGIN
    SELECT i.user_id INTO v_user_id FROM instances i WHERE i.id = p_instance_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'instance % not found', p_instance_id USING ERRCODE = 'GR004';
    END IF;
    PERFORM _fn_assert_actor(v_user_id);

    INSERT INTO instance_env_vars (instance_id, name, value_encrypted)
    VALUES (p_instance_id, p_name, pgp_sym_encrypt(p_value, _fn_enc_key()))
    ON CONFLICT (instance_id, name) DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted;
END
$$;

CREATE FUNCTION fn_env_get(p_instance_id uuid, p_name text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_id bigint;
    v_cipher  bytea;
BEGIN
    SELECT i.user_id INTO v_user_id FROM instances i WHERE i.id = p_instance_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'instance % not found', p_instance_id USING ERRCODE = 'GR004';
    END IF;
    PERFORM _fn_assert_actor(v_user_id);

    SELECT e.value_encrypted INTO v_cipher
    FROM instance_env_vars e WHERE e.instance_id = p_instance_id AND e.name = p_name;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN pgp_sym_decrypt(v_cipher, _fn_enc_key());   -- неверный ключ -> ошибка "Wrong key or corrupt data"
END
$$;

COMMENT ON FUNCTION fn_start_instance(bigint, bigint, bigint, integer, pricing_type, bigint, text, integer, bigint) IS
    'FR-07: проверки, снимок цены, подбор gpu_count GPU одной online-ноды (FOR UPDATE SKIP LOCKED), аллокация. Возвращает id инстанса.';
COMMENT ON FUNCTION fn_resume_instance(uuid) IS
    'stopped -> running: новый подбор GPU в том же ДЦ, новый снимок цены, сброс last_billed_at.';
COMMENT ON FUNCTION fn_stop_instance(uuid) IS
    'running -> stopped: дотарифицирует интервал до момента остановки и освобождает GPU.';
COMMENT ON FUNCTION fn_terminate_instance(uuid) IS
    'Необратимое завершение инстанса из любого не-terminated состояния; running дотарифицируется.';
COMMENT ON FUNCTION fn_bill_usage(timestamptz, bigint) IS
    'Биллинг-проход: usage_records + charge одной транзакцией, автостоп при балансе <= 0. Идемпотентен на тот же момент.';
COMMENT ON FUNCTION fn_topup(bigint) IS
    'Идемпотентное зачисление платежа: true — зачислено сейчас, false — платёж уже был зачтён.';
COMMENT ON FUNCTION fn_env_set(uuid, text, text) IS 'Шифрует значение ключом app.enc_key и сохраняет переменную окружения инстанса.';
COMMENT ON FUNCTION fn_env_get(uuid, text) IS 'Расшифровывает переменную ключом app.enc_key; при неверном ключе — ошибка.';

INSERT INTO schema_migrations (version) VALUES ('0008_functions');
COMMIT;

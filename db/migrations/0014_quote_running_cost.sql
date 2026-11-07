-- 0014: проверка «баланс >= 1 часа» (FR-07) учитывает уже работающие инстансы пользователя.
--
-- В 0008 баланс сравнивался только со стоимостью часа запускаемого инстанса: при балансе на один час
-- одной GPU можно было запустить сколько угодно инстансов, а баланс уходил в минус до очередного прохода
-- биллинга (автостоп). Теперь баланс должен покрыть час нового инстанса плюс час всех его running-инстансов
-- (price_per_hour_snapshot — стоимость часа всего инстанса, gpu_count уже учтён). Остановленный инстанс при
-- fn_resume_instance в сумму не попадает (он не running), двойного счёта нет.
-- Сигнатура и права не меняются, поэтому CREATE OR REPLACE; 0008 остаётся как есть (история применённых миграций).
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

CREATE OR REPLACE FUNCTION _fn_quote_instance(p_user_id bigint, p_datacenter_id bigint, p_gpu_model_id bigint,
                                              p_gpu_count integer, p_pricing_type pricing_type, p_at timestamptz)
RETURNS numeric
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_price   numeric;
    v_total   numeric;
    v_running numeric;
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
    SELECT coalesce(sum(i.price_per_hour_snapshot), 0) INTO v_running
    FROM instances i
    WHERE i.user_id = p_user_id AND i.status = 'running';

    IF (SELECT u.balance FROM users u WHERE u.id = p_user_id) < v_total + v_running THEN
        RAISE EXCEPTION 'insufficient balance: need at least % for one hour (new instance % + running instances %)',
            v_total + v_running, v_total, v_running USING ERRCODE = 'GR002';
    END IF;
    RETURN v_total;
END
$$;

INSERT INTO schema_migrations (version) VALUES ('0014_quote_running_cost');
COMMIT;

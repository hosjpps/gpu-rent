-- 11: представления: каталог v_gpu_availability и витрина mv_daily_revenue (без размножения сумм).
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_system() \g /dev/null

CREATE FUNCTION pg_temp.avail(p_dc bigint, OUT total int, OUT enabled int, OUT busy int, OUT free int, OUT p_od numeric, OUT p_spot numeric)
LANGUAGE sql AS $$
    SELECT total_gpus::int, enabled_gpus::int, busy_gpus::int, free_gpus::int, price_on_demand, price_spot
    FROM v_gpu_availability WHERE datacenter_id = p_dc AND gpu_model_id = pg_temp.fx('ma')
$$;

DO $$
DECLARE
    dc1 bigint := pg_temp.fx('dc1'); r record; v_id uuid;
BEGIN
    SELECT * INTO r FROM pg_temp.avail(dc1);
    PERFORM pg_temp.assert_true(r.total = 6 AND r.enabled = 6 AND r.busy = 0 AND r.free = 6, 'catalog: fresh DC has 6 total / 6 enabled / 0 busy / 6 free');
    PERFORM pg_temp.assert_true(r.p_od = 100 AND r.p_spot = 50, 'catalog: current on_demand and spot prices (not multiplied by the join)');

    v_id := fn_start_instance(pg_temp.fx('u1'), dc1, pg_temp.fx('ma'), 3, 'on_demand', pg_temp.fx('tpl'), 'cat');
    SELECT * INTO r FROM pg_temp.avail(dc1);
    PERFORM pg_temp.assert_true(r.total = 6 AND r.busy = 3 AND r.free = 3, 'catalog: 3 GPUs became busy, 3 remain free');

    UPDATE gpus SET is_enabled = false WHERE id = (SELECT g.id FROM gpus g WHERE g.node_id = pg_temp.fx('n2') AND slot_index = 0);
    SELECT * INTO r FROM pg_temp.avail(dc1);
    PERFORM pg_temp.assert_true(r.enabled = 5 AND r.free = 2, 'catalog: a disabled GPU is neither enabled nor free');

    UPDATE nodes SET status = 'offline' WHERE id = pg_temp.fx('n2');
    SELECT * INTO r FROM pg_temp.avail(dc1);
    PERFORM pg_temp.assert_eq(r.free, 1, 'catalog: GPUs of an offline node are not free (only the last GPU of n1 remains)');
    PERFORM pg_temp.assert_eq(r.free, (SELECT count(*)::int FROM gpus g JOIN nodes n ON n.id = g.node_id
                                       WHERE n.datacenter_id = dc1 AND n.status = 'online' AND g.is_enabled
                                         AND NOT EXISTS (SELECT 1 FROM instance_gpus ig WHERE ig.gpu_id = g.id AND upper_inf(ig.allocated_during))),
                              'catalog: free = enabled GPUs of online nodes without an active allocation');

    PERFORM fn_stop_instance(v_id);
    UPDATE nodes SET status = 'online' WHERE id = pg_temp.fx('n2');
    UPDATE gpus SET is_enabled = true WHERE node_id = pg_temp.fx('n2');
    SELECT * INTO r FROM pg_temp.avail(dc1);
    PERFORM pg_temp.assert_true(r.busy = 0 AND r.free = 6, 'catalog: everything is free again after stop');

    -- будущая цена в каталоге не показывается: он отдаёт ту, что действует сейчас
    UPDATE gpu_prices SET valid_during = tstzrange(lower(valid_during), now() + interval '10 days', '[)')
     WHERE datacenter_id = dc1 AND gpu_model_id = pg_temp.fx('ma') AND pricing_type = 'on_demand';
    INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
    VALUES (dc1, pg_temp.fx('ma'), 'on_demand', 999, tstzrange(now() + interval '10 days', NULL));
    SELECT * INTO r FROM pg_temp.avail(dc1);
    PERFORM pg_temp.assert_eq(r.p_od, 100.0000, 'catalog: a price that starts in the future is not shown');

    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM v_gpu_availability WHERE datacenter_id = dc1 AND gpu_model_id = pg_temp.fx('mb')),
                                'catalog: a model without GPUs in the DC has no row');

    UPDATE datacenters SET is_active = false WHERE id = dc1;
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM v_gpu_availability WHERE datacenter_id = dc1), 'catalog: an inactive datacenter is hidden');
    UPDATE datacenters SET is_active = true WHERE id = dc1;
END
$$;
ROLLBACK;

-- Витрина выручки: 4-GPU инстанс на час = 400 RUB и 4 GPU-часа, а не 1600.
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); v_id uuid; t0 timestamptz; v_day date; r record;
BEGIN
    PERFORM pg_temp.no_storage();
    v_id := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 4, 'on_demand', pg_temp.fx('tpl'), 'revenue');   -- 400 RUB/h
    PERFORM pg_temp.age_instance(v_id, interval '1 hour');
    SELECT last_billed_at INTO t0 FROM instances WHERE id = v_id;
    PERFORM fn_bill_usage(t0 + interval '1 hour');
    PERFORM fn_refresh_daily_revenue();

    v_day := (t0 AT TIME ZONE 'Europe/Moscow')::date;
    SELECT * INTO r FROM mv_daily_revenue WHERE day = v_day AND datacenter_id = pg_temp.fx('dc1') AND gpu_model_id = pg_temp.fx('ma');
    PERFORM pg_temp.assert_eq(r.revenue, 400.0000, 'mv_daily_revenue: revenue of a 4-GPU instance is counted once (400, not 1600)');
    PERFORM pg_temp.assert_eq(r.gpu_hours, 4.0000, 'mv_daily_revenue: 1 hour * 4 GPUs = 4 GPU-hours');
    PERFORM pg_temp.assert_eq(r.usage_rows, 1::bigint, 'mv_daily_revenue: one usage row');

    -- итог витрины по фикстурному ДЦ совпадает с суммой сырых начислений
    PERFORM pg_temp.assert_eq((SELECT sum(revenue) FROM mv_daily_revenue WHERE datacenter_id = pg_temp.fx('dc1')),
                              (SELECT sum(u.amount) FROM usage_records u JOIN instances i ON i.id = u.instance_id JOIN nodes n ON n.id = i.node_id
                               WHERE u.kind = 'gpu' AND n.datacenter_id = pg_temp.fx('dc1')),
                              'mv_daily_revenue total equals the raw GPU usage total');

    -- клиенту REFRESH недоступен
    PERFORM pg_temp.as_user(u1);
    PERFORM pg_temp.assert_raises('SELECT fn_refresh_daily_revenue()', '42501', 'refreshing the dashboard needs a system/admin context');
END
$$;
ROLLBACK;

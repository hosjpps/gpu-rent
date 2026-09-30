-- 01: EXCLUDE и CHECK на диапазонах: двойная аллокация GPU, пересечение периодов цен.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql

DO $$
DECLARE
    v_gpu0 bigint; v_gpu1 bigint; v_a uuid; v_b uuid; t0 timestamptz := now();
BEGIN
    SELECT id INTO v_gpu0 FROM gpus WHERE node_id = pg_temp.fx('n1') AND slot_index = 0;
    SELECT id INTO v_gpu1 FROM gpus WHERE node_id = pg_temp.fx('n1') AND slot_index = 1;
    v_a := pg_temp.raw_instance(pg_temp.fx('u1'), pg_temp.fx('n1'), pg_temp.fx('ma'));
    v_b := pg_temp.raw_instance(pg_temp.fx('u2'), pg_temp.fx('n1'), pg_temp.fx('ma'));

    INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (v_a, v_gpu0, tstzrange(t0, NULL));

    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (%L, %s, tstzrange(now(), NULL))', v_b, v_gpu0),
        '23P01', 'double allocation of one GPU (open ranges) is rejected by EXCLUDE');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (%L, %s, tstzrange(%L, %L))',
               v_b, v_gpu0, t0 + interval '1 hour', t0 + interval '2 hours'),
        '23P01', 'finite range inside an open allocation is rejected');

    -- та же GPU, но строго после закрытия предыдущей аллокации: граница [a,b) и [b,c) не пересекается
    INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (v_a, v_gpu1, tstzrange(t0, t0 + interval '1 hour'));
    INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (v_b, v_gpu1, tstzrange(t0 + interval '1 hour', NULL));
    PERFORM pg_temp.ok('adjacent allocations [a,b) and [b,c) on one GPU are allowed');
END
$$;

DO $$
BEGIN
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (%L, (SELECT id FROM gpus LIMIT 1), %L)',
               pg_temp.raw_instance(pg_temp.fx('u1'), pg_temp.fx('n1'), pg_temp.fx('ma')), 'empty'),
        '23514', 'empty allocation range is rejected by CHECK');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (%L, (SELECT id FROM gpus LIMIT 1), tstzrange(NULL, now()))',
               pg_temp.raw_instance(pg_temp.fx('u1'), pg_temp.fx('n1'), pg_temp.fx('ma'))),
        '23514', 'allocation range without lower bound is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (%L, (SELECT id FROM gpus LIMIT 1), tstzrange(now(), now() + interval ''1 hour'', ''(]''))',
               pg_temp.raw_instance(pg_temp.fx('u1'), pg_temp.fx('n1'), pg_temp.fx('ma'))),
        '23514', 'allocation range with exclusive lower bound is rejected');
END
$$;

-- Цены: периоды одного товара (ДЦ x модель x тариф) не пересекаются.
DO $$
BEGIN
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during) VALUES (%s, %s, ''on_demand'', 90, tstzrange(now(), now() + interval ''10 days''))',
               pg_temp.fx('dc1'), pg_temp.fx('ma')),
        '23P01', 'overlapping price period for the same product is rejected');

    -- другой тариф, другая модель, другой ДЦ пересечься не могут
    INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
    VALUES (pg_temp.fx('dc1'), pg_temp.fx('mb'), 'on_demand', 300, tstzrange(now(), NULL));
    PERFORM pg_temp.ok('same time range for another model is allowed');
END
$$;

DO $$
DECLARE
    v_end timestamptz;
BEGIN
    -- закрываем открытый период ценой "сегодня" и открываем следующий впритык: граница не пересекается
    SELECT now() + interval '1 day' INTO v_end;
    UPDATE gpu_prices SET valid_during = tstzrange(lower(valid_during), v_end, '[)')
     WHERE datacenter_id = pg_temp.fx('dc1') AND gpu_model_id = pg_temp.fx('ma') AND pricing_type = 'on_demand';
    INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
    VALUES (pg_temp.fx('dc1'), pg_temp.fx('ma'), 'on_demand', 110, tstzrange(v_end, NULL));
    PERFORM pg_temp.assert_true(
        (SELECT count(*) FROM gpu_prices WHERE datacenter_id = pg_temp.fx('dc1') AND gpu_model_id = pg_temp.fx('ma')
           AND pricing_type = 'on_demand') = 2, 'adjacent price periods [a,b) and [b,inf) are accepted');

    PERFORM pg_temp.assert_raises(
        format('INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during) VALUES (%s, %s, ''spot'', 0, tstzrange(now() + interval ''5 years'', NULL))',
               pg_temp.fx('dc1'), pg_temp.fx('ma')),
        '23514', 'non-positive price is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during) VALUES (%s, %s, ''spot'', ''NaN'', tstzrange(now() + interval ''5 years'', NULL))',
               pg_temp.fx('dc1'), pg_temp.fx('ma')),
        '23514', 'NaN price is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during) VALUES (%s, %s, ''spot'', 10, tstzrange(NULL, now() - interval ''100 days''))',
               pg_temp.fx('dc1'), pg_temp.fx('ma')),
        '23514', 'price period without start is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO storage_prices (datacenter_id, price_per_gb_month, valid_during) VALUES (%s, 20, tstzrange(now(), now() + interval ''1 day''))', pg_temp.fx('dc1')),
        '23P01', 'overlapping storage price period is rejected');
END
$$;

ROLLBACK;

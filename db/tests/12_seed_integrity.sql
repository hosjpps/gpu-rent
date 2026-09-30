-- 12: целостность и правдоподобие сида (только чтение). Без сида тест пропускается.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql

DO $$
DECLARE
    v_bad bigint;
BEGIN
    IF (SELECT count(*) FROM users) < 1000 THEN
        PERFORM pg_temp.ok('seed is not loaded, integrity checks skipped');
        RETURN;
    END IF;

    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM datacenters), 4, 'seed: 4 datacenters');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM gpu_models), 6, 'seed: 6 GPU models');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM nodes), 60, 'seed: 60 nodes');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM gpus) BETWEEN 380 AND 420, 'seed: about 400 GPUs');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM users), 5000, 'seed: 5000 users');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instances), 20000, 'seed: 20000 instances');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM usage_records) >= 1000000, 'seed: at least 1 000 000 usage records');
    PERFORM pg_temp.assert_true((SELECT min(period_start) >= timestamptz '2025-10-01 00:00:00+00' AND max(period_end) <= timestamptz '2026-10-01 00:00:00+00' FROM usage_records),
                                'seed: usage covers 2025-10 .. 2026-09');

    -- деньги
    SELECT count(*) INTO v_bad FROM users u
    WHERE u.balance IS DISTINCT FROM coalesce((SELECT sum(t.amount) FROM transactions t WHERE t.user_id = u.id), 0);
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: users.balance equals SUM(transactions) for every user');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM transactions WHERE type = 'charge'), (SELECT count(*) FROM usage_records), 'seed: one charge per usage record');
    SELECT count(*) INTO v_bad FROM transactions t JOIN usage_records x ON x.id = t.usage_id AND x.period_start = t.usage_period_start
    WHERE t.type = 'charge' AND (t.amount <> -x.amount OR t.user_id <> x.user_id);
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: every charge equals its usage record (amount and owner)');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM users WHERE balance < 0), 0::bigint, 'seed: no negative balances');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM payments p WHERE p.status = 'succeeded' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.payment_id = p.id AND t.type = 'topup')), 0::bigint,
                              'seed: every succeeded payment is credited exactly once');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM transactions t WHERE t.type = 'topup' AND t.amount <> (SELECT p.amount FROM payments p WHERE p.id = t.payment_id)), 0::bigint,
                              'seed: topup amounts equal payment amounts');

    -- партиции и индексы
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM usage_records_default), 0::bigint, 'seed: default partition is empty');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                               WHERE c.relnamespace = 'gpu_rent'::regnamespace AND NOT i.indisvalid), 0::bigint,
                              'seed: every index of the schema is valid (none lost while reloading)');
    SELECT count(*) INTO v_bad FROM pg_inherits h JOIN pg_class p ON p.oid = h.inhrelid
    WHERE h.inhparent = 'gpu_rent.usage_records'::regclass
      AND (SELECT count(*) FROM pg_indexes x WHERE x.schemaname = 'gpu_rent' AND x.tablename = p.relname
                AND (x.indexdef LIKE '%USING brin (period_start)%' OR x.indexdef LIKE '%USING btree (user_id, period_start)%')) <> 2;
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: each partition has the BRIN(period_start) and btree(user_id, period_start) indexes');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM pg_indexes WHERE schemaname = 'gpu_rent' AND tablename = 'transactions'), 5::bigint,
                              'seed: transactions has its 5 indexes (pk, user_created, payment, unique topup, unique charge)');

    -- GPU и инстансы
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM instance_gpus WHERE upper_inf(allocated_during)),
                              (SELECT coalesce(sum(gpu_count), 0) FROM instances WHERE status = 'running'),
                              'seed: open allocations equal the GPUs of running instances');
    SELECT count(*) INTO v_bad FROM instances i
    WHERE (SELECT count(DISTINCT g.node_id) FROM instance_gpus ig JOIN gpus g ON g.id = ig.gpu_id WHERE ig.instance_id = i.id) > 1
       OR (SELECT count(DISTINCT ig.gpu_id) FROM instance_gpus ig WHERE ig.instance_id = i.id) <> i.gpu_count;
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: every instance has exactly gpu_count distinct GPUs on one node');
    SELECT count(*) INTO v_bad FROM instances i
    JOIN volumes v ON v.id = i.volume_id JOIN nodes n ON n.id = i.node_id WHERE v.datacenter_id <> n.datacenter_id;
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: volume and node of every instance share a datacenter');
    SELECT count(*) INTO v_bad FROM (SELECT volume_id FROM instances WHERE volume_id IS NOT NULL AND status IN ('pending', 'running', 'stopped') GROUP BY volume_id HAVING count(*) > 1) s;
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: no volume has two live instances');
    SELECT count(*) INTO v_bad FROM instances i
    WHERE i.status <> 'failed'
      AND i.price_per_hour_snapshot <> i.gpu_count * (SELECT gp.price_per_hour FROM gpu_prices gp JOIN nodes n ON n.id = i.node_id
                                                      WHERE gp.datacenter_id = n.datacenter_id AND gp.gpu_model_id = i.gpu_model_id
                                                        AND gp.pricing_type = i.pricing_type AND gp.valid_during @> i.started_at);
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: price snapshot equals gpu_count * price valid at start');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM instances WHERE status = 'running') BETWEEN 50 AND 400, 'seed: a realistic number of running instances');

    -- витрина
    SELECT count(*) INTO v_bad FROM (
        SELECT (u.period_start AT TIME ZONE 'Europe/Moscow')::date AS day, n.datacenter_id, i.gpu_model_id, sum(u.amount) AS revenue
        FROM usage_records u JOIN instances i ON i.id = u.instance_id JOIN nodes n ON n.id = i.node_id
        WHERE u.kind = 'gpu' GROUP BY 1, 2, 3) raw
    FULL JOIN mv_daily_revenue mv USING (day, datacenter_id, gpu_model_id)
    WHERE raw.revenue IS DISTINCT FROM mv.revenue;
    PERFORM pg_temp.assert_eq(v_bad, 0::bigint, 'seed: mv_daily_revenue equals the raw aggregate in every row');

    -- цены
    PERFORM pg_temp.assert_true((SELECT price_on_demand BETWEEN 60 AND 90 FROM v_gpu_availability WHERE datacenter_code = 'MSK-1' AND gpu_model = 'RTX 4090'), 'seed: RTX 4090 on-demand is 60-90 RUB/h');
    PERFORM pg_temp.assert_true((SELECT price_on_demand BETWEEN 250 AND 320 FROM v_gpu_availability WHERE datacenter_code = 'MSK-1' AND gpu_model = 'A100 80GB'), 'seed: A100 80GB on-demand is 250-320 RUB/h');
    PERFORM pg_temp.assert_true((SELECT price_on_demand BETWEEN 450 AND 600 FROM v_gpu_availability WHERE datacenter_code = 'MSK-1' AND gpu_model = 'H100 80GB'), 'seed: H100 on-demand is 450-600 RUB/h');
    PERFORM pg_temp.assert_true((SELECT bool_and(price_spot / price_on_demand BETWEEN 0.495 AND 0.605) FROM v_gpu_availability), 'seed: spot is 40-50 percent cheaper than on-demand');

    -- ПДн и ключи
    PERFORM pg_temp.assert_true((SELECT bool_and(password_hash ~ '^\$2[abxy]\$') FROM users), 'seed: only bcrypt-shaped password hashes are stored');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM api_keys WHERE octet_length(key_hash) <> 32), 0::bigint, 'seed: API keys are stored as sha256 hashes');
    PERFORM pg_temp.assert_eq((SELECT count(*) FROM instance_env_vars WHERE value_encrypted IS NULL OR position('hf_'::bytea IN value_encrypted) > 0), 0::bigint, 'seed: env secrets are stored encrypted');
END
$$;
ROLLBACK;

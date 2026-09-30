-- 06: согласованность владельца (составные FK) и проверки целостности строк.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2');
    v_inst uuid; v_usage_id bigint; v_usage_start timestamptz; v_pay bigint;
BEGIN
    v_inst := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'owner');
    PERFORM pg_temp.age_instance(v_inst, interval '1 hour');
    PERFORM fn_bill_usage((SELECT last_billed_at + interval '1 hour' FROM instances WHERE id = v_inst));
    SELECT id, period_start INTO v_usage_id, v_usage_start FROM usage_records WHERE instance_id = v_inst;

    -- потребление чужого инстанса нельзя записать на другого пользователя
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount) VALUES (%s, %L, ''gpu'', now() + interval ''1 day'', now() + interval ''2 days'', 10, 1)', u2, v_inst),
        '23503', 'usage record with the instance of another user is rejected (composite FK)');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, volume_id, kind, period_start, period_end, quantity, amount) VALUES (%s, %s, ''storage'', now() + interval ''1 day'', now() + interval ''2 days'', 10, 1)', u2, pg_temp.fx('vol1')),
        '23503', 'usage record with the volume of another user is rejected (composite FK)');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, volume_id, name, pricing_type, gpu_count, container_disk_gb, price_per_hour_snapshot, status, started_at, last_billed_at) VALUES (%s, %s, %s, %s, %s, ''x'', ''on_demand'', 1, 50, 100, ''running'', now(), now())',
               u2, pg_temp.fx('n1'), pg_temp.fx('ma'), pg_temp.fx('tpl'), pg_temp.fx('vol1')),
        '23503', 'instance of user 2 with the volume of user 1 is rejected (composite FK)');

    -- платёж другого пользователя в журнале
    INSERT INTO payments (user_id, provider, provider_payment_id, amount, status, paid_at) VALUES (u1, 'test', 'own-1', 10, 'succeeded', now()) RETURNING id INTO v_pay;
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO transactions (user_id, type, amount, payment_id) VALUES (%s, ''topup'', 10, %s)', u2, v_pay),
        '23503', 'ledger row of user 2 cannot reference the payment of user 1');

    -- ссылка на потребление должна быть по полному ключу (id, period_start)
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO transactions (user_id, type, amount, usage_id, usage_period_start) VALUES (%s, ''charge'', -1, %s, %L)', u1, v_usage_id, v_usage_start + interval '1 second'),
        '23503', 'charge with a wrong usage_period_start is rejected (FK on the full key)');

    -- CHECK-и usage_records
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, instance_id, volume_id, kind, period_start, period_end, quantity, amount) VALUES (%s, %L, %s, ''gpu'', now() + interval ''3 days'', now() + interval ''4 days'', 1, 1)', u1, v_inst, pg_temp.fx('vol1')),
        '23514', 'gpu usage with both instance and volume is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount) VALUES (%s, %L, ''storage'', now() + interval ''3 days'', now() + interval ''4 days'', 1, 1)', u1, v_inst),
        '23514', 'storage usage bound to an instance is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, kind, period_start, period_end, quantity, amount) VALUES (%s, ''gpu'', now() + interval ''3 days'', now() + interval ''4 days'', 1, 1)', u1),
        '23514', 'usage without any object is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount) VALUES (%s, %L, ''gpu'', now() + interval ''3 days'', now() + interval ''3 days'', 1, 1)', u1, v_inst),
        '23514', 'usage with period_end = period_start is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount) VALUES (%s, %L, ''gpu'', now() + interval ''3 days'', now() + interval ''4 days'', ''NaN'', 1)', u1, v_inst),
        '23514', 'NaN quantity is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount) VALUES (%s, %L, ''gpu'', now() + interval ''3 days'', now() + interval ''4 days'', 1, -1)', u1, v_inst),
        '23514', 'negative usage amount is rejected');

    -- целостность строк пользователей, шаблонов, инстансов
    PERFORM pg_temp.assert_raises('INSERT INTO users (email, password_hash, full_name) VALUES (''tst-plain@example.test'', ''password123'', ''X'')', '23514', 'plain-text password is rejected by the bcrypt format check');
    PERFORM pg_temp.assert_raises('INSERT INTO users (email, password_hash, full_name) VALUES (''not-an-email'', ''$2b$12$'' || repeat(''z'', 53), ''X'')', '23514', 'malformed email is rejected');
    PERFORM pg_temp.assert_raises('INSERT INTO users (email, password_hash, full_name) VALUES (''TST-U1@EXAMPLE.TEST'', ''$2b$12$'' || repeat(''z'', 53), ''X'')', '23505', 'email is unique case-insensitively (citext)');
    PERFORM pg_temp.assert_raises('INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (NULL, ''x'', ''y'', 10, false)', '23514', 'template without owner must be public');
    PERFORM pg_temp.assert_raises(format('INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (%s, ''x'', ''y'', 10, true)', u1), '23514', 'public template must have no owner');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, name, pricing_type, gpu_count, container_disk_gb, price_per_hour_snapshot, status) VALUES (%s, %s, %s, %s, ''x'', ''on_demand'', 9, 50, 100, ''pending'')', u1, pg_temp.fx('n1'), pg_temp.fx('ma'), pg_temp.fx('tpl')),
        '23514', 'gpu_count above 8 is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, name, pricing_type, gpu_count, container_disk_gb, price_per_hour_snapshot, status) VALUES (%s, %s, %s, %s, ''x'', ''on_demand'', 1, 50, 100, ''running'')', u1, pg_temp.fx('n1'), pg_temp.fx('ma'), pg_temp.fx('tpl')),
        '23514', 'running instance without started_at/last_billed_at is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, name, pricing_type, gpu_count, container_disk_gb, price_per_hour_snapshot, status) VALUES (%s, %s, %s, %s, ''x'', ''on_demand'', 1, 50, ''NaN'', ''pending'')', u1, pg_temp.fx('n1'), pg_temp.fx('ma'), pg_temp.fx('tpl')),
        '23514', 'NaN price snapshot is rejected');
    -- GPU из другой ноды/модели в аллокации
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during) VALUES (%L, (SELECT id FROM gpus WHERE node_id = %s LIMIT 1), tstzrange(now() + interval ''10 days'', NULL))', v_inst, pg_temp.fx('n3')),
        '23514', 'allocation of a GPU from another node is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (%s, ''k'', ''abcd1234'', ''\x00''::bytea)', u1),
        '23514', 'api key hash must be 32 bytes (sha256)');
END
$$;
ROLLBACK;

-- 03: жизненный цикл инстанса: подбор GPU (ровно gpu_count, одна нода), отказы по GPU/балансу/статусу,
-- stop/resume/terminate, тома (один ДЦ, один активный инстанс на том), права вызова.

-- ===== A. Подбор GPU: ровно gpu_count на одной ноде ======================================================
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
CREATE FUNCTION pg_temp.q_start(p_user bigint, p_dc bigint, p_count int, p_type text DEFAULT 'on_demand',
                                p_vol bigint DEFAULT NULL, p_model bigint DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
    SELECT format('SELECT fn_start_instance(%s, %s, %s, %s, %L, %s, ''t'', NULL, %s)',
                  p_user, p_dc, coalesce(p_model, pg_temp.fx('ma')), p_count, p_type, pg_temp.fx('tpl'),
                  coalesce(p_vol::text, 'NULL'))
$$;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null

DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); dc1 bigint := pg_temp.fx('dc1'); ma bigint := pg_temp.fx('ma');
    v_id uuid; v_nodes bigint; v_models bigint; v_open int;
BEGIN
    -- свободно 4 + 2 = 6 GPU, но ни на одной ноде нет 5 подряд
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 5), 'GR001', '5 GPUs are refused although 6 are free in total (no single node has 5)');

    v_id := fn_start_instance(u1, dc1, ma, 4, 'on_demand', pg_temp.fx('tpl'), 'four');
    SELECT count(DISTINCT g.node_id), count(DISTINCT g.gpu_model_id), count(*) INTO v_nodes, v_models, v_open
    FROM instance_gpus ig JOIN gpus g ON g.id = ig.gpu_id
    WHERE ig.instance_id = v_id AND upper_inf(ig.allocated_during);
    PERFORM pg_temp.assert_eq(v_open, 4, 'fn_start_instance allocated exactly gpu_count (4) GPUs');
    PERFORM pg_temp.assert_eq(v_nodes, 1, 'all allocated GPUs belong to one node');
    PERFORM pg_temp.assert_eq(v_models, 1, 'all allocated GPUs have the requested model');
    PERFORM pg_temp.assert_eq((SELECT node_id FROM instances WHERE id = v_id), pg_temp.fx('n1'), 'instance.node_id is the node of its GPUs (the only node with 4 free)');
    PERFORM pg_temp.assert_eq((SELECT price_per_hour_snapshot FROM instances WHERE id = v_id), 400.0000, 'price snapshot = 4 GPU * 100 RUB/h');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v_id), 'running', 'new instance is running');

    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 3), 'GR001', '3 GPUs are refused: n1 is full, n2 has only 2');
    v_id := fn_start_instance(u1, dc1, ma, 2, 'on_demand', pg_temp.fx('tpl'), 'two');
    PERFORM pg_temp.assert_eq((SELECT node_id FROM instances WHERE id = v_id), pg_temp.fx('n2'), '2 GPUs go to node n2');
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 1), 'GR001', 'nothing is free: a further start is refused');
    PERFORM pg_temp.assert_eq((SELECT sum(free_gpus)::int FROM v_gpu_availability WHERE datacenter_id = dc1), 0, 'catalog shows 0 free GPUs');
END
$$;
ROLLBACK;

-- ===== B. Best fit, спот-тариф, отключённые GPU и ноды ===================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); dc1 bigint := pg_temp.fx('dc1'); ma bigint := pg_temp.fx('ma');
    v_id uuid;
BEGIN
    v_id := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'single');
    PERFORM pg_temp.assert_eq((SELECT node_id FROM instances WHERE id = v_id), pg_temp.fx('n2'), 'best fit: a 1-GPU request goes to the node with fewer free GPUs (n2)');

    v_id := fn_start_instance(u1, dc1, ma, 2, 'spot', pg_temp.fx('tpl'), 'spot');
    PERFORM pg_temp.assert_eq((SELECT price_per_hour_snapshot FROM instances WHERE id = v_id), 100.0000, 'spot snapshot = 2 GPU * 50 RUB/h');

    -- отключённая GPU и нода в обслуживании выпадают из подбора
    UPDATE gpus SET is_enabled = false WHERE node_id = pg_temp.fx('n1');
    PERFORM pg_temp.assert_eq((SELECT free_gpus::int FROM v_gpu_availability WHERE datacenter_id = dc1 AND gpu_model_id = ma), 1,
                              'catalog: only the last free GPU of n2 remains after disabling n1');
    UPDATE gpus SET is_enabled = true WHERE node_id = pg_temp.fx('n1');
    UPDATE nodes SET status = 'maintenance' WHERE id = pg_temp.fx('n1');
    PERFORM pg_temp.assert_eq((SELECT free_gpus::int FROM v_gpu_availability WHERE datacenter_id = dc1 AND gpu_model_id = ma), 1,
                              'catalog: GPUs of a node in maintenance are not free');
    PERFORM pg_temp.assert_raises(format('SELECT fn_start_instance(%s, %s, %s, 2, ''on_demand'', %s, ''x'')', u1, dc1, ma, pg_temp.fx('tpl')),
                                  'GR001', 'nothing suitable while n1 is in maintenance');
END
$$;
ROLLBACK;

-- ===== C. stop / resume / terminate =====================================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); dc1 bigint := pg_temp.fx('dc1'); ma bigint := pg_temp.fx('ma');
    v_id uuid; v_old_start timestamptz;
BEGIN
    v_id := fn_start_instance(u1, dc1, ma, 2, 'on_demand', pg_temp.fx('tpl'), 'cycle');
    PERFORM pg_temp.age_instance(v_id, interval '1 hour');   -- «работает уже час»
    SELECT started_at INTO v_old_start FROM instances WHERE id = v_id;

    PERFORM fn_stop_instance(v_id);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v_id), 'stopped', 'stop: status stopped');
    PERFORM pg_temp.assert_true((SELECT stopped_at IS NOT NULL FROM instances WHERE id = v_id), 'stop: stopped_at is set');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_gpus WHERE instance_id = v_id AND upper_inf(allocated_during)), 0, 'stop: allocations are closed, GPUs released');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM transactions WHERE user_id = u1 AND type = 'charge'), 1, 'stop: the working interval was billed before release');
    PERFORM pg_temp.assert_true((SELECT -amount FROM transactions WHERE user_id = u1 AND type = 'charge') BETWEEN 200.0 AND 201.0, 'stop: charge is about 1 hour * 200 RUB');
    PERFORM pg_temp.assert_raises(format('SELECT fn_stop_instance(%L)', v_id), 'GR003', 'stop of a stopped instance is refused');

    -- цена выросла: повторный старт обязан взять новый снимок
    UPDATE gpu_prices SET valid_during = tstzrange(lower(valid_during), now() - interval '1 second', '[)')
     WHERE datacenter_id = dc1 AND gpu_model_id = ma AND pricing_type = 'on_demand';
    INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
    VALUES (dc1, ma, 'on_demand', 120, tstzrange(now() - interval '1 second', NULL));

    PERFORM fn_resume_instance(v_id);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v_id), 'running', 'resume: status running');
    PERFORM pg_temp.assert_eq((SELECT price_per_hour_snapshot FROM instances WHERE id = v_id), 240.0000, 'resume: new price snapshot (2 * 120)');
    PERFORM pg_temp.assert_true((SELECT started_at > v_old_start AND last_billed_at = started_at FROM instances WHERE id = v_id), 'resume: last_billed_at is reset to the new start');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_gpus WHERE instance_id = v_id AND upper_inf(allocated_during)), 2, 'resume: 2 new open allocations');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_gpus WHERE instance_id = v_id), 4, 'resume: old closed allocations are kept as history');
    PERFORM pg_temp.assert_raises(format('SELECT fn_resume_instance(%L)', v_id), 'GR003', 'resume of a running instance is refused');

    PERFORM pg_temp.age_instance(v_id, interval '30 minutes');
    PERFORM fn_terminate_instance(v_id);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v_id), 'terminated', 'terminate: status terminated');
    PERFORM pg_temp.assert_true((SELECT terminated_at IS NOT NULL FROM instances WHERE id = v_id), 'terminate: terminated_at is set');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_gpus WHERE instance_id = v_id AND upper_inf(allocated_during)), 0, 'terminate: GPUs released');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM transactions WHERE user_id = u1 AND type = 'charge'), 2, 'terminate of a running instance bills the last interval');

    PERFORM pg_temp.assert_raises(format('SELECT fn_resume_instance(%L)', v_id), 'GR003', 'terminated instance cannot be resumed');
    PERFORM pg_temp.assert_raises(format('SELECT fn_stop_instance(%L)', v_id), 'GR003', 'terminated instance cannot be stopped');
    PERFORM pg_temp.assert_raises(format('SELECT fn_terminate_instance(%L)', v_id), 'GR003', 'terminated instance cannot be terminated again');
    PERFORM pg_temp.assert_raises(format('UPDATE instances SET status = ''running'', started_at = now(), last_billed_at = now(), terminated_at = NULL WHERE id = %L', v_id),
                                  '23001', 'terminated is irreversible even by a direct UPDATE');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), (SELECT sum(amount) FROM transactions WHERE user_id = u1), 'balance equals SUM(transactions) after the whole lifecycle');

    -- terminate из stopped: без лишнего списания
    v_id := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'to-stop');
    PERFORM fn_stop_instance(v_id);
    PERFORM fn_terminate_instance(v_id);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v_id), 'terminated', 'stopped instance can be terminated');
    PERFORM pg_temp.assert_true((SELECT stopped_at IS NOT NULL AND terminated_at >= stopped_at FROM instances WHERE id = v_id), 'terminate from stopped keeps stopped_at');

    -- прямые нарушения
    v_id := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'guards');
    PERFORM pg_temp.assert_raises(format('UPDATE instances SET gpu_count = 2 WHERE id = %L', v_id), '23001', 'gpu_count of an instance is immutable');
    PERFORM pg_temp.assert_raises(format('UPDATE instances SET user_id = %s WHERE id = %L', pg_temp.fx('u2'), v_id), '23001', 'owner of an instance is immutable');
    PERFORM pg_temp.assert_raises(format('UPDATE instances SET status = ''pending'' WHERE id = %L', v_id), '23001', 'running -> pending is not an allowed transition');
END
$$;
ROLLBACK;

-- ===== D. Отказы: баланс, блокировка, цена, шаблон, права ================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
CREATE FUNCTION pg_temp.q_start(p_user bigint, p_dc bigint, p_count int, p_type text DEFAULT 'on_demand',
                                p_vol bigint DEFAULT NULL, p_model bigint DEFAULT NULL, p_tpl bigint DEFAULT NULL) RETURNS text
LANGUAGE sql AS $$
    SELECT format('SELECT fn_start_instance(%s, %s, %s, %s, %L, %s, ''t'', NULL, %s)',
                  p_user, p_dc, coalesce(p_model, pg_temp.fx('ma')), p_count, p_type, coalesce(p_tpl, pg_temp.fx('tpl')),
                  coalesce(p_vol::text, 'NULL'))
$$;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2'); u3 bigint := pg_temp.fx('u3');
    dc1 bigint := pg_temp.fx('dc1'); dc2 bigint := pg_temp.fx('dc2'); ma bigint := pg_temp.fx('ma');
    v_tpl_private bigint; v_id uuid;
BEGIN
    -- баланс
    PERFORM pg_temp.as_user(u3);
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u3, dc1, 1), 'GR002', 'user with zero balance cannot start an instance');
    PERFORM pg_temp.as_user(u1);
    INSERT INTO transactions (user_id, type, amount, description) VALUES (u1, 'adjustment', -9901, 'leave 99 RUB');
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 1), 'GR002', 'balance 99 < price of one hour (100) is refused');
    INSERT INTO transactions (user_id, type, amount, description) VALUES (u1, 'bonus', 1, 'exactly 100 RUB');
    v_id := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'boundary');
    PERFORM pg_temp.assert_true(v_id IS NOT NULL, 'balance exactly equal to the hour price is enough');
    PERFORM fn_terminate_instance(v_id);
    INSERT INTO transactions (user_id, type, amount, description) VALUES (u1, 'bonus', 9900, 'restore');

    -- статус пользователя
    UPDATE users SET status = 'blocked' WHERE id = u1;
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 1), 'GR003', 'blocked user cannot start an instance');
    UPDATE users SET status = 'active' WHERE id = u1;

    -- цена, ДЦ, аргументы
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 1, 'on_demand', NULL, pg_temp.fx('mb')), 'GR004', 'model without a price in the datacenter is refused');
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc2, 1, 'spot'), 'GR004', 'spot price absent in TST-2 is refused');
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, 0, 1), 'GR004', 'unknown datacenter is refused');
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 0), 'GR005', 'gpu_count 0 is refused');
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 9), 'GR005', 'gpu_count 9 is refused');

    -- шаблоны: чужой приватный недоступен, свой приватный доступен
    INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (u2, 'private', 'x/y', 30, false) RETURNING id INTO v_tpl_private;
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 1, 'on_demand', NULL, NULL, v_tpl_private), 'GR004', 'private template of another user is not available');
    PERFORM pg_temp.as_user(u2);
    v_id := fn_start_instance(u2, dc1, ma, 1, 'on_demand', v_tpl_private, 'own-private');
    PERFORM pg_temp.assert_eq((SELECT container_disk_gb FROM instances WHERE id = v_id), 30, 'container disk defaults to the template value');
    PERFORM pg_temp.assert_true(v_id IS NOT NULL, 'owner can use his private template');

    -- права вызова: клиент действует только от своего имени, админ и система — от любого
    PERFORM pg_temp.as_user(u2);
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 1), '42501', 'client cannot start an instance on behalf of another user');
    PERFORM pg_temp.as_user(u1);
    PERFORM pg_temp.assert_raises(format('SELECT fn_stop_instance(%L)', v_id), '42501', 'client cannot stop an instance of another user');
    PERFORM pg_temp.assert_raises(format('SELECT fn_terminate_instance(%L)', v_id), '42501', 'client cannot terminate an instance of another user');
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.user_role', '', true);
    PERFORM pg_temp.assert_raises(pg_temp.q_start(u1, dc1, 1), '42501', 'empty context cannot start anything');
    PERFORM pg_temp.as_user(pg_temp.fx('adm'), 'admin');
    PERFORM fn_stop_instance(v_id);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v_id), 'stopped', 'admin can stop an instance of any user');
    PERFORM pg_temp.as_system();
    PERFORM fn_terminate_instance(v_id);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v_id), 'terminated', 'system context can terminate an instance');
END
$$;
ROLLBACK;

-- ===== E. Сетевые тома ===================================================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2');
    dc1 bigint := pg_temp.fx('dc1'); dc2 bigint := pg_temp.fx('dc2'); ma bigint := pg_temp.fx('ma');
    vol1 bigint := pg_temp.fx('vol1'); vol2 bigint := pg_temp.fx('vol2');
    v_id uuid; v_second uuid; v_raw uuid;
BEGIN
    -- том другого ДЦ
    PERFORM pg_temp.assert_raises(
        format('SELECT fn_start_instance(%s, %s, %s, 1, ''on_demand'', %s, ''x'', NULL, %s)', u1, dc1, ma, pg_temp.fx('tpl'), vol2),
        'GR005', 'function: volume of another datacenter is refused');
    -- нода и том разных ДЦ при прямой вставке: страхует триггер, а не только функция
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, volume_id, name, pricing_type, gpu_count, container_disk_gb, price_per_hour_snapshot, status, started_at, last_billed_at) VALUES (%s, %s, %s, %s, %s, ''x'', ''on_demand'', 1, 50, 100, ''running'', now(), now())',
               u1, pg_temp.fx('n1'), ma, pg_temp.fx('tpl'), vol2),
        '23514', 'trigger: node of TST-1 and volume of TST-2 cannot be combined');
    -- том чужого пользователя
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, volume_id, name, pricing_type, gpu_count, container_disk_gb, price_per_hour_snapshot, status, started_at, last_billed_at) VALUES (%s, %s, %s, %s, %s, ''x'', ''on_demand'', 1, 50, 100, ''running'', now(), now())',
               u2, pg_temp.fx('n1'), ma, pg_temp.fx('tpl'), vol1),
        '23503', 'composite FK: instance of user 2 cannot use the volume of user 1');

    v_id := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'with-volume', NULL, vol1);
    PERFORM pg_temp.assert_eq((SELECT volume_id FROM instances WHERE id = v_id), vol1, 'instance is started with its volume');

    PERFORM pg_temp.assert_raises(
        format('SELECT fn_start_instance(%s, %s, %s, 1, ''on_demand'', %s, ''second'', NULL, %s)', u1, dc1, ma, pg_temp.fx('tpl'), vol1),
        'GR003', 'function: second live instance on the same volume is refused');
    v_raw := pg_temp.raw_instance(u1, pg_temp.fx('n2'), ma, 1, 'stopped');
    PERFORM pg_temp.assert_raises(
        format('UPDATE instances SET volume_id = %s WHERE id = %L', vol1, v_raw),
        '23505', 'unique index: second live instance on the same volume is refused even by a direct UPDATE');

    -- остановленный инстанс продолжает держать том
    PERFORM fn_stop_instance(v_id);
    PERFORM pg_temp.assert_raises(
        format('SELECT fn_start_instance(%s, %s, %s, 1, ''on_demand'', %s, ''third'', NULL, %s)', u1, dc1, ma, pg_temp.fx('tpl'), vol1),
        'GR003', 'a stopped instance still holds its volume');
    PERFORM pg_temp.assert_raises(format('UPDATE volumes SET status = ''deleted'', deleted_at = now() WHERE id = %s', vol1),
                                  '23001', 'volume attached to a live instance cannot be deleted');

    -- после терминации том свободен
    PERFORM fn_terminate_instance(v_id);
    v_second := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'after-terminate', NULL, vol1);
    PERFORM pg_temp.assert_true(v_second IS NOT NULL, 'after termination the volume can be attached again');
    PERFORM fn_terminate_instance(v_second);

    -- жизненный цикл самого тома
    PERFORM pg_temp.assert_raises(format('UPDATE volumes SET size_gb = 50 WHERE id = %s', vol1), '23001', 'volume cannot shrink');
    PERFORM pg_temp.assert_raises(format('UPDATE volumes SET size_gb = 20000 WHERE id = %s', vol1), '23514', 'volume larger than 10000 GB is refused');
    UPDATE volumes SET size_gb = 200 WHERE id = vol1;
    PERFORM pg_temp.ok('volume can be extended');
    PERFORM pg_temp.assert_raises(format('UPDATE volumes SET datacenter_id = %s WHERE id = %s', dc2, vol1), '23001', 'datacenter of a volume is immutable');
    UPDATE volumes SET status = 'deleted', deleted_at = now() WHERE id = vol1;
    PERFORM pg_temp.ok('detached volume can be deleted');
    PERFORM pg_temp.assert_raises(format('UPDATE volumes SET status = ''active'', deleted_at = NULL WHERE id = %s', vol1), '23001', 'deleted volume cannot be restored');
    PERFORM pg_temp.assert_raises(
        format('SELECT fn_start_instance(%s, %s, %s, 1, ''on_demand'', %s, ''x'', NULL, %s)', u1, dc1, ma, pg_temp.fx('tpl'), vol1),
        'GR004', 'deleted volume cannot be attached');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO volumes (user_id, datacenter_id, name, size_gb) VALUES (%s, %s, ''tiny'', 5)', u1, dc1), '23514', 'volume smaller than 10 GB is refused');
END
$$;
ROLLBACK;

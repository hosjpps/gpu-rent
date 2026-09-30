-- 10: аудит: смена роли/статуса пользователя, изменения цен GPU, смена статуса инстанса -> audit_log.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql

CREATE FUNCTION pg_temp.audit_count(p_action text, p_entity_id text DEFAULT NULL) RETURNS int
LANGUAGE sql AS $$ SELECT count(*)::int FROM audit_log WHERE action = p_action AND (p_entity_id IS NULL OR entity_id = p_entity_id) $$;

SELECT pg_temp.as_user(pg_temp.fx('adm'), 'admin'), set_config('app.client_ip', '203.0.113.7', true) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); r record;
BEGIN
    UPDATE users SET status = 'blocked' WHERE id = u1;
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('user.status_changed', u1::text), 1, 'status change writes one audit row');
    SELECT * INTO r FROM audit_log WHERE action = 'user.status_changed' AND entity_id = u1::text;
    PERFORM pg_temp.assert_eq(r.details, '{"from": "active", "to": "blocked"}'::jsonb, 'audit details hold the old and new status');
    PERFORM pg_temp.assert_eq(r.actor_user_id, pg_temp.fx('adm'), 'actor is taken from app.user_id');
    PERFORM pg_temp.assert_eq(host(r.ip), '203.0.113.7', 'ip is taken from app.client_ip');
    PERFORM pg_temp.assert_eq(r.entity, 'users', 'entity is the table name');

    UPDATE users SET role = 'admin' WHERE id = u1;
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('user.role_changed', u1::text), 1, 'role change writes one audit row');
    PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM audit_log WHERE action = 'user.role_changed' AND details @> '{"from": "client", "to": "admin"}'), 'details are searchable with @> (GIN jsonb_path_ops)');

    UPDATE users SET status = 'blocked' WHERE id = u1;   -- то же значение
    UPDATE users SET full_name = 'Другое Имя' WHERE id = u1;
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('user.status_changed', u1::text), 1, 'rewriting the same status and editing the name add no audit rows');

    UPDATE users SET status = 'blocked', role = 'client' WHERE id = pg_temp.fx('u2');
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('user.status_changed', pg_temp.fxt('u2')), 1, 'one UPDATE changing status and role (role same) audits status only');
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('user.role_changed', pg_temp.fxt('u2')), 0, '... and not the unchanged role');
END
$$;

DO $$
DECLARE
    v_id bigint; v_before int;
BEGIN
    SELECT count(*) INTO v_before FROM audit_log WHERE action LIKE 'gpu_price.%';
    INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
    VALUES (pg_temp.fx('dc1'), pg_temp.fx('mb'), 'on_demand', 300, tstzrange(now(), NULL)) RETURNING id INTO v_id;
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('gpu_price.insert', v_id::text), 1, 'price insert is audited');
    PERFORM pg_temp.assert_eq((SELECT details #>> '{new,price_per_hour}' FROM audit_log WHERE action = 'gpu_price.insert' AND entity_id = v_id::text), '300.0000', 'insert audit keeps the new price');

    UPDATE gpu_prices SET price_per_hour = 330 WHERE id = v_id;
    PERFORM pg_temp.assert_eq((SELECT details #>> '{old,price_per_hour}' || ' -> ' || (details #>> '{new,price_per_hour}') FROM audit_log WHERE action = 'gpu_price.update' AND entity_id = v_id::text),
                              '300.0000 -> 330.0000', 'update audit keeps the old and the new price');

    DELETE FROM gpu_prices WHERE id = v_id;
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('gpu_price.delete', v_id::text), 1, 'price delete is audited');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM audit_log WHERE action LIKE 'gpu_price.%') = v_before + 3, 'exactly three audit rows for insert/update/delete');
END
$$;

DO $$
DECLARE
    u2 bigint := pg_temp.fx('u2'); v_id uuid;
BEGIN
    UPDATE users SET status = 'active' WHERE id = u2;
    PERFORM pg_temp.as_user(u2);
    v_id := fn_start_instance(u2, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'audited');
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('instance.status_changed', v_id::text), 0, 'creating an instance is not a status change');
    PERFORM fn_stop_instance(v_id);
    PERFORM pg_temp.assert_eq((SELECT details FROM audit_log WHERE action = 'instance.status_changed' AND entity_id = v_id::text),
                              jsonb_build_object('user_id', u2, 'from', 'running', 'to', 'stopped'), 'stop writes from/to');
    PERFORM pg_temp.assert_eq((SELECT actor_user_id FROM audit_log WHERE action = 'instance.status_changed' AND entity_id = v_id::text), u2, 'actor of the status change is the user who stopped it');
    PERFORM fn_terminate_instance(v_id);
    PERFORM pg_temp.assert_eq(pg_temp.audit_count('instance.status_changed', v_id::text), 2, 'terminate adds a second record');
END
$$;
ROLLBACK;

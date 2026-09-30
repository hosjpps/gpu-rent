-- 07: роли и RLS. Проверки выполняются под реальными ролями (SET LOCAL ROLE), а не суперпользователем.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql

-- Пустой контекст (app.user_id вообще не задавался): строк нет, ошибки нет.
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instances), 0, 'no app.user_id at all: zero instances, no error');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM transactions), 0, 'no app.user_id at all: zero ledger rows');
END
$$;
RESET ROLE;

-- Данные двух пользователей: инстанс, ключи, списания.
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2'); i1 uuid; i2 uuid; v2 bigint;
BEGIN
    i1 := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'u1-inst');
    i2 := fn_start_instance(u2, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'u2-inst');
    INSERT INTO volumes (user_id, datacenter_id, name, size_gb) VALUES (u2, pg_temp.fx('dc1'), 'u2-vol', 50) RETURNING id INTO v2;
    INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES
        (u1, 'k1', 'ssh-ed25519 AAAA1', 'SHA256:u1'), (u2, 'k2', 'ssh-ed25519 AAAA2', 'SHA256:u2');
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES
        (u1, 'a1', 'gr_aaaaa', digest('secret-1', 'sha256')), (u2, 'a2', 'gr_bbbbb', digest('secret-2', 'sha256'));
    PERFORM pg_temp.age_instance(i1, interval '1 hour');
    PERFORM pg_temp.age_instance(i2, interval '1 hour');
    PERFORM fn_bill_usage((SELECT last_billed_at + interval '1 hour' FROM instances WHERE id = i1));
    PERFORM set_config('fx.i1', i1::text, true);
    PERFORM set_config('fx.i2', i2::text, true);
END
$$;

CREATE FUNCTION pg_temp.visible_users(p_table regclass) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v text;
BEGIN
    EXECUTE format('SELECT coalesce(string_agg(DISTINCT user_id::text, '','' ORDER BY user_id::text), '''') FROM %s '
                   'WHERE user_id IN (%s, %s)', p_table, pg_temp.fx('u1'), pg_temp.fx('u2')) INTO v;
    RETURN v;
END
$$;

SET LOCAL ROLE gpu_rent_app;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
DO $$
DECLARE
    u1 text := pg_temp.fxt('u1'); u2 text := pg_temp.fxt('u2'); t regclass;
BEGIN
    FOREACH t IN ARRAY ARRAY['instances', 'volumes', 'ssh_keys', 'api_keys', 'transactions', 'payments', 'usage_records']::regclass[] LOOP
        PERFORM pg_temp.assert_eq(pg_temp.visible_users(t), u1, format('app.user_id=u1: %s shows only rows of u1', t));
    END LOOP;
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instances WHERE user_id = pg_temp.fx('u2')), 0, 'u1 cannot see the instance of u2 even by an explicit filter');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit_log), 0, 'non-admin cannot read audit_log');
END
$$;
SELECT pg_temp.as_user(pg_temp.fx('u2')) \g /dev/null
DO $$
DECLARE
    u2 text := pg_temp.fxt('u2'); t regclass;
BEGIN
    FOREACH t IN ARRAY ARRAY['instances', 'volumes', 'ssh_keys', 'api_keys', 'transactions', 'payments', 'usage_records']::regclass[] LOOP
        PERFORM pg_temp.assert_eq(pg_temp.visible_users(t), u2, format('app.user_id=u2: %s shows only rows of u2', t));
    END LOOP;
END
$$;

-- Администратор видит всех.
SELECT pg_temp.as_user(pg_temp.fx('adm'), 'admin') \g /dev/null
DO $$
DECLARE
    both_ text := pg_temp.fxt('u1') || ',' || pg_temp.fxt('u2'); t regclass;
BEGIN
    FOREACH t IN ARRAY ARRAY['instances', 'volumes', 'ssh_keys', 'api_keys', 'transactions', 'payments', 'usage_records']::regclass[] LOOP
        PERFORM pg_temp.assert_true(pg_temp.visible_users(t) IN (both_, pg_temp.fxt('u2') || ',' || pg_temp.fxt('u1')),
                                    format('admin: %s shows rows of both users', t));
    END LOOP;
    PERFORM pg_temp.assert_true((SELECT count(*) FROM audit_log) > 0, 'admin can read audit_log');
END
$$;

-- Запись под чужим user_id блокируется WITH CHECK; чужие строки нельзя ни изменить, ни удалить.
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2'); n int;
BEGIN
    PERFORM pg_temp.assert_raises(format('INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES (%s, ''evil'', ''ssh-rsa AAAA'', ''SHA256:evil'')', u2),
                                  '42501', 'u1 cannot insert an ssh key for u2 (WITH CHECK)');
    PERFORM pg_temp.assert_raises(format('INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (%s, ''yk'', ''evil'', 1)', u2),
                                  '42501', 'u1 cannot create a payment for u2');
    UPDATE instances SET name = 'hacked' WHERE id = pg_temp.fxt('i2')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'UPDATE of the instance of u2 affects 0 rows');
    DELETE FROM ssh_keys WHERE user_id = u2;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'DELETE of ssh keys of u2 affects 0 rows');
    INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES (u1, 'own', 'ssh-rsa AAAA', 'SHA256:own');
    PERFORM pg_temp.ok('u1 can insert its own ssh key');
    UPDATE instances SET name = 'renamed' WHERE id = pg_temp.fxt('i1')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 1, 'u1 can rename its own instance');
END
$$;

-- Права приложения: баланс, журналы, DDL, внутренние функции.
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1');
BEGIN
    PERFORM pg_temp.assert_raises(format('UPDATE users SET balance = 1000000 WHERE id = %s', u1), '42501', 'app cannot UPDATE users.balance (column privilege)');
    PERFORM pg_temp.assert_raises('INSERT INTO users (email, password_hash, full_name, balance) VALUES (''tst-x@example.test'', ''$2b$12$'' || repeat(''x'', 53), ''X'', 5)', '42501', 'app cannot set balance on INSERT');
    PERFORM pg_temp.assert_raises(format('UPDATE users SET balance = 1 WHERE id = %s', u1), '42501', 'app cannot UPDATE users.balance even on its own row');
    PERFORM pg_temp.assert_raises('INSERT INTO transactions (user_id, type, amount) VALUES (1, ''bonus'', 1)', '42501', 'app cannot INSERT into transactions');
    PERFORM pg_temp.assert_raises('UPDATE transactions SET amount = 0', '42501', 'app cannot UPDATE transactions');
    PERFORM pg_temp.assert_raises('DELETE FROM transactions', '42501', 'app cannot DELETE from transactions');
    PERFORM pg_temp.assert_raises('TRUNCATE transactions', '42501', 'app cannot TRUNCATE transactions');
    PERFORM pg_temp.assert_raises('UPDATE audit_log SET action = ''x''', '42501', 'app cannot UPDATE audit_log');
    PERFORM pg_temp.assert_raises('DELETE FROM audit_log', '42501', 'app cannot DELETE from audit_log');
    PERFORM pg_temp.assert_raises('TRUNCATE audit_log', '42501', 'app cannot TRUNCATE audit_log');
    PERFORM pg_temp.assert_raises('INSERT INTO usage_records (user_id, kind) VALUES (1, ''gpu'')', '42501', 'app cannot INSERT into usage_records');
    PERFORM pg_temp.assert_raises('DELETE FROM usage_records', '42501', 'app cannot DELETE from usage_records');
    PERFORM pg_temp.assert_raises('TRUNCATE usage_records', '42501', 'app cannot TRUNCATE usage_records');
    PERFORM pg_temp.assert_raises('CREATE TABLE gpu_rent.evil (id int)', '42501', 'app cannot run DDL in the schema');
    PERFORM pg_temp.assert_raises('DROP TABLE gpu_rent.payments', '42501', 'app cannot drop tables');
    PERFORM pg_temp.assert_raises('SELECT gpu_rent._fn_bill_instance(gen_random_uuid(), now())', '42501', 'app cannot call internal helper functions');
    PERFORM pg_temp.assert_raises('SELECT gpu_rent.fn_bill_usage()', '42501', 'app role without system context cannot bill');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM v_gpu_availability) > 0, 'app can read the catalog view');
    PERFORM pg_temp.assert_true((SELECT count(*) >= 0 FROM mv_daily_revenue), 'app can read the revenue view');
    INSERT INTO audit_log (action, entity, entity_id) VALUES ('test.app_event', 'tests', '1');
    PERFORM pg_temp.ok('app can append to audit_log');
END
$$;
RESET ROLE;

-- Функции жизненного цикла работают под ролью приложения (EXECUTE выдан, RLS внутри SECURITY DEFINER не мешает).
SET LOCAL ROLE gpu_rent_app;
SELECT pg_temp.as_user(pg_temp.fx('u1')), set_config('app.enc_key', 'role-test-key', true) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); v uuid;
BEGIN
    v := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'by-app-role');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instances WHERE id = v), 1, 'app role: fn_start_instance works and the new instance is visible to its owner through RLS');
    PERFORM fn_env_set(v, 'TOKEN', 'abc');
    PERFORM pg_temp.assert_eq(fn_env_get(v, 'TOKEN'), 'abc', 'app role: fn_env_set / fn_env_get work');
    PERFORM fn_stop_instance(v);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v), 'stopped', 'app role: fn_stop_instance works');
    PERFORM fn_resume_instance(v);
    PERFORM fn_terminate_instance(v);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = v), 'terminated', 'app role: fn_resume_instance and fn_terminate_instance work');
    PERFORM pg_temp.as_system();
    PERFORM fn_bill_usage();
    PERFORM pg_temp.ok('app role with a system context can run the billing pass');
    PERFORM fn_refresh_daily_revenue();
    PERFORM pg_temp.ok('app role with a system context can refresh the revenue view');
    PERFORM pg_temp.assert_true(fn_ensure_usage_partition('2031-03-01') = 'usage_records_2031_03', 'app role with a system context can create the next usage partition');
    PERFORM pg_temp.as_user(u1);
    PERFORM pg_temp.assert_raises('SELECT fn_ensure_usage_partition(''2031-04-01'')', '42501', 'app role with a client context cannot create partitions');
    PERFORM pg_temp.assert_true(to_regclass('gpu_rent.usage_records_2031_04') IS NULL, 'the rejected call created no partition');
END
$$;
RESET ROLE;

-- Аналитик: только три объекта.
SET LOCAL ROLE gpu_rent_analyst;
DO $$
BEGIN
    PERFORM pg_temp.assert_raises('SELECT * FROM users', '42501', 'analyst cannot SELECT from users');
    PERFORM pg_temp.assert_raises('SELECT email FROM users', '42501', 'analyst cannot SELECT users.email');
    PERFORM pg_temp.assert_raises('SELECT * FROM transactions', '42501', 'analyst cannot SELECT from transactions');
    PERFORM pg_temp.assert_raises('SELECT * FROM instances', '42501', 'analyst cannot SELECT from instances');
    PERFORM pg_temp.assert_raises('SELECT * FROM payments', '42501', 'analyst cannot SELECT from payments');
    PERFORM pg_temp.assert_raises('SELECT * FROM audit_log', '42501', 'analyst cannot SELECT from audit_log');
    PERFORM pg_temp.assert_raises('SELECT * FROM api_keys', '42501', 'analyst cannot SELECT from api_keys');
    PERFORM pg_temp.assert_raises('UPDATE v_users_masked SET status = ''blocked''', '42501', 'analyst cannot modify data');
    PERFORM pg_temp.assert_raises('SELECT gpu_rent.fn_topup(1)', '42501', 'analyst cannot call business functions');

    PERFORM pg_temp.assert_true((SELECT count(*) FROM v_users_masked) > 0, 'analyst can read v_users_masked');
    PERFORM pg_temp.assert_true((SELECT count(*) >= 0 FROM mv_daily_revenue), 'analyst can read mv_daily_revenue');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM v_gpu_availability) > 0, 'analyst can read v_gpu_availability');
    PERFORM pg_temp.assert_eq((SELECT email_masked FROM v_users_masked WHERE id = pg_temp.fx('u1')), 'ts***@example.test', 'email is masked: two characters and the domain');
    PERFORM pg_temp.assert_eq((SELECT full_name_masked FROM v_users_masked WHERE id = pg_temp.fx('u1')), 'И. И. И.', 'full name is reduced to initials');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM v_users_masked WHERE email_masked LIKE '%tst-u1%' OR full_name_masked LIKE '%Иванов%'),
                                'no unmasked personal data in the view');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'v_users_masked' AND column_name IN ('email', 'password_hash', 'full_name')),
                                'the view has no raw email/password_hash/full_name columns');
END
$$;
RESET ROLE;

-- Роль без выданных прав (REVOKE ALL FROM PUBLIC).
CREATE ROLE tst_nobody NOLOGIN;
SET LOCAL ROLE tst_nobody;
DO $$
BEGIN
    PERFORM pg_temp.assert_raises('SELECT count(*) FROM gpu_rent.users', '42501', 'a role without grants cannot read users (no PUBLIC access)');
    PERFORM pg_temp.assert_raises('SELECT count(*) FROM gpu_rent.v_gpu_availability', '42501', 'a role without grants cannot read the catalog');
    PERFORM pg_temp.assert_raises('SELECT gpu_rent.fn_bill_usage()', '42501', 'a role without grants cannot execute business functions');
END
$$;
RESET ROLE;

ROLLBACK;

-- 14: веб-слой (0013): сессии, ограничение частоты, регистрация и подтверждение email, API-ключи,
-- биллинг при обращении, уведомления шлюза, блокировка пользователей, сужение прав и RLS на users/templates.
-- Проверки под настоящей ролью приложения (SET LOCAL ROLE gpu_rent_app), как в 07.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql

-- ---------------------------------------------------------------------------------------------
-- Новые таблицы закрыты: приложение работает с ними только через функции.
-- ---------------------------------------------------------------------------------------------
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_raises('SELECT count(*) FROM gpu_rent.sessions', '42501', 'app cannot read sessions directly');
    PERFORM pg_temp.assert_raises('DELETE FROM gpu_rent.sessions', '42501', 'app cannot delete sessions directly');
    PERFORM pg_temp.assert_raises('SELECT count(*) FROM gpu_rent.auth_attempts', '42501', 'app cannot read auth_attempts directly');
    PERFORM pg_temp.assert_raises('SELECT count(*) FROM gpu_rent.email_tokens', '42501', 'app cannot read email_tokens directly');
    PERFORM pg_temp.assert_raises('SELECT count(*) FROM gpu_rent.billing_runs', '42501', 'app cannot read billing_runs directly');
END
$$;
RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- Ограничение частоты
-- ---------------------------------------------------------------------------------------------
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    v_retry integer;
BEGIN
    PERFORM pg_temp.assert_eq(fn_auth_throttle_hit('login_email', 'a@x.test', 3, 900), 0, 'throttle: attempt 1 is accepted');
    PERFORM pg_temp.assert_eq(fn_auth_throttle_hit('login_email', 'a@x.test', 3, 900), 0, 'throttle: attempt 2 is accepted');
    PERFORM pg_temp.assert_eq(fn_auth_throttle_hit('login_email', 'a@x.test', 3, 900), 0, 'throttle: attempt 3 is accepted');
    v_retry := fn_auth_throttle_hit('login_email', 'a@x.test', 3, 900);
    PERFORM pg_temp.assert_true(v_retry BETWEEN 1 AND 900, 'throttle: attempt 4 is blocked, retry-after is within the window');
    PERFORM pg_temp.assert_eq(fn_auth_throttle_hit('login_email', 'b@x.test', 3, 900), 0, 'throttle: another key is independent');
    PERFORM pg_temp.assert_eq(fn_auth_throttle_hit('login_ip', 'a@x.test', 3, 900), 0, 'throttle: another scope is independent');
    PERFORM fn_auth_throttle_clear('login_email', 'a@x.test');
    PERFORM pg_temp.assert_eq(fn_auth_throttle_hit('login_email', 'a@x.test', 3, 900), 0, 'throttle: a successful login clears the counter');
END
$$;
RESET ROLE;
DO $$
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM auth_attempts WHERE scope = 'login_email' AND key = 'b@x.test'), 1, 'throttle: one row per accepted attempt');
    -- попытка, отклонённая лимитом, не записывается: окно не продлевается бесконечно
    INSERT INTO auth_attempts (scope, key, created_at) VALUES ('t_window', 'k', clock_timestamp() - interval '20 minutes');
    PERFORM pg_temp.assert_eq(fn_auth_throttle_hit('t_window', 'k', 1, 900), 0, 'throttle: attempts older than the window do not count');
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Регистрация, подтверждение email, учётные данные для входа
-- ---------------------------------------------------------------------------------------------
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    v_id bigint; v_dup text;
BEGIN
    v_id := fn_web_register('New.User@Example.test', '$2b$12$' || repeat('e', 53), 'Новый Пользователь', digest('tok-verify-1', 'sha256'), 3600);
    PERFORM pg_temp.assert_true(v_id IS NOT NULL, 'register: returns the id of the new user');
    PERFORM set_config('fx.newuser', v_id::text, true);
    PERFORM pg_temp.assert_raises(
        format('SELECT fn_web_register(%L, %L, %L, digest(''tok-verify-2'', ''sha256''), 3600)',
               'new.user@example.test', '$2b$12$' || repeat('e', 53), 'Дубликат'),
        '23505', 'register: the same email in another letter case is rejected');
    PERFORM pg_temp.assert_eq((SELECT o_status::text FROM fn_web_user_by_email('NEW.USER@example.test')), 'active', 'login lookup is case-insensitive');
    PERFORM pg_temp.assert_eq((SELECT o_password_hash FROM fn_web_user_by_email('new.user@example.test')), '$2b$12$' || repeat('e', 53), 'login lookup returns the bcrypt hash');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM fn_web_user_by_email('nobody@example.test')), 'login lookup: unknown email gives no rows');
END
$$;
RESET ROLE;
DO $$
DECLARE
    v_id bigint := pg_temp.fx('newuser');
BEGIN
    PERFORM pg_temp.assert_true((SELECT role = 'client' AND status = 'active' AND balance = 0 AND email_verified_at IS NULL FROM users WHERE id = v_id),
                                'register: new user is a client, active, zero balance, email not verified');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM email_tokens WHERE user_id = v_id AND used_at IS NULL), 1, 'register: one verification token is created');
END
$$;
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    v_id bigint := pg_temp.fx('newuser');
BEGIN
    PERFORM pg_temp.assert_true(fn_web_verify_email(digest('no-such-token', 'sha256')) IS NULL, 'verify: unknown token is rejected');
    PERFORM pg_temp.assert_eq(fn_web_verify_email(digest('tok-verify-1', 'sha256')), v_id, 'verify: valid token returns the user id');
    PERFORM pg_temp.assert_true(fn_web_verify_email(digest('tok-verify-1', 'sha256')) IS NULL, 'verify: the token cannot be used twice');
END
$$;
RESET ROLE;
DO $$
BEGIN
    PERFORM pg_temp.assert_true((SELECT email_verified_at IS NOT NULL FROM users WHERE id = pg_temp.fx('newuser')), 'verify: email_verified_at is set');
    INSERT INTO email_tokens (user_id, token_hash, expires_at, created_at)
    VALUES (pg_temp.fx('u1'), digest('tok-expired', 'sha256'), now() - interval '1 minute', now() - interval '2 hours');
    PERFORM pg_temp.assert_true(fn_web_verify_email(digest('tok-expired', 'sha256')) IS NULL, 'verify: expired token is rejected');
END
$$;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM fn_web_email_token_create(digest('tok-resend-1', 'sha256'), 3600);
    PERFORM fn_web_email_token_create(digest('tok-resend-2', 'sha256'), 3600);
    PERFORM pg_temp.assert_true(fn_web_verify_email(digest('tok-resend-1', 'sha256')) IS NULL, 'resend: the previous link stops working');
    PERFORM pg_temp.assert_eq(fn_web_verify_email(digest('tok-resend-2', 'sha256')), pg_temp.fx('u1'), 'resend: the new link verifies the email');
    PERFORM pg_temp.assert_raises('SELECT fn_web_email_token_create(digest(''tok-resend-3'', ''sha256''), 3600)', 'GR003', 'resend: an already verified email gives GR003');
END
$$;
RESET ROLE;
SELECT set_config('app.user_id', '', true), set_config('app.user_role', '', true) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_raises('SELECT fn_web_email_token_create(digest(''tok-anon'', ''sha256''), 3600)', '42501', 'resend: needs a user context');
END
$$;
RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- Сессии
-- ---------------------------------------------------------------------------------------------
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); r record; v_exp timestamptz;
BEGIN
    v_exp := fn_session_create(u1, digest('sess-1', 'sha256'), 604800, '203.0.113.7', 'test-agent');
    PERFORM pg_temp.assert_true(v_exp > now() + interval '6 days 23 hours', 'session: expires in 7 days');
    SELECT * INTO r FROM fn_session_resolve(digest('sess-1', 'sha256'), 604800, 600);
    PERFORM pg_temp.assert_eq(r.o_user_id, u1, 'session: resolve returns the owner');
    PERFORM pg_temp.assert_eq(r.o_email, 'tst-u1@example.test', 'session: resolve returns the email');
    PERFORM pg_temp.assert_eq(r.o_role::text, 'client', 'session: resolve returns the role');
    PERFORM pg_temp.assert_eq(r.o_renewed, false, 'session: a fresh session is not renewed on every request');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM fn_session_resolve(digest('sess-unknown', 'sha256'), 604800, 600)), 'session: unknown token gives no rows');
    PERFORM pg_temp.assert_raises('SELECT fn_session_create(pg_temp.fx(''u1''), digest(''sess-1'', ''sha256''), 60, NULL, NULL)', '23505', 'session: token hash is unique');
END
$$;
RESET ROLE;
UPDATE sessions SET last_seen_at = now() - interval '20 minutes', expires_at = now() + interval '2 days' WHERE token_hash = digest('sess-1', 'sha256');
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    r record;
BEGIN
    SELECT * INTO r FROM fn_session_resolve(digest('sess-1', 'sha256'), 604800, 600);
    PERFORM pg_temp.assert_eq(r.o_renewed, true, 'session: a stale last_seen_at renews the session (sliding expiry)');
    PERFORM pg_temp.assert_true(r.o_expires_at > now() + interval '6 days 23 hours', 'session: renewed expiry is again 7 days ahead');
    PERFORM fn_session_delete(digest('sess-1', 'sha256'));
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM fn_session_resolve(digest('sess-1', 'sha256'), 604800, 600)), 'session: logout removes it');
END
$$;
RESET ROLE;
DO $$
BEGIN
    INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
    VALUES (pg_temp.fx('u1'), digest('sess-old', 'sha256'), now() - interval '8 days', now() - interval '1 day');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM fn_session_resolve(digest('sess-old', 'sha256'), 604800, 600)), 'session: expired token is not resolved');
    UPDATE users SET status = 'blocked' WHERE id = pg_temp.fx('u3');
    PERFORM pg_temp.assert_raises(format('SELECT fn_session_create(%s, digest(''sess-blocked'', ''sha256''), 60, NULL, NULL)', pg_temp.fx('u3')), 'GR003', 'session: a blocked user gets no session');
    UPDATE users SET status = 'active' WHERE id = pg_temp.fx('u3');
END
$$;

-- Смена пароля: все сессии пользователя удаляются, создаётся одна новая.
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1');
BEGIN
    PERFORM fn_session_create(u1, digest('pw-sess-a', 'sha256'), 604800, NULL, NULL);
    PERFORM fn_session_create(u1, digest('pw-sess-b', 'sha256'), 604800, NULL, NULL);
    PERFORM fn_session_create(pg_temp.fx('u2'), digest('pw-sess-u2', 'sha256'), 604800, NULL, NULL);
END
$$;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1');
BEGIN
    PERFORM pg_temp.assert_eq(fn_web_password_hash(), '$2b$12$' || repeat('a', 53), 'password: the user reads own hash through the function');
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (u1, 'pw-key-1', 'gr_pwkey', digest('pw-key-1', 'sha256')), (u1, 'pw-key-2', 'gr_pwkey', digest('pw-key-2', 'sha256'));
    PERFORM fn_web_set_password('$2b$12$' || repeat('n', 53), digest('pw-sess-new', 'sha256'), 604800, NULL, 'ua');
    PERFORM pg_temp.assert_eq(fn_web_password_hash(), '$2b$12$' || repeat('n', 53), 'password: the hash is replaced');
END
$$;
RESET ROLE;
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1');
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM sessions WHERE user_id = u1), 1, 'password: all sessions are dropped and one new session is created');
    PERFORM pg_temp.assert_true(EXISTS (SELECT 1 FROM sessions WHERE token_hash = digest('pw-sess-new', 'sha256')), 'password: the remaining session is the new one');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM sessions WHERE user_id = pg_temp.fx('u2')), 1, 'password: sessions of other users are untouched');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit_log WHERE action = 'user.password_changed' AND actor_user_id = u1), 1, 'password: the change is written to audit_log');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM api_keys WHERE user_id = u1 AND name LIKE 'pw-key-%' AND revoked_at IS NULL), 0, 'password: active API keys are revoked');
    PERFORM pg_temp.assert_eq((SELECT (details->>'api_keys_revoked')::int FROM audit_log WHERE action = 'user.password_changed' AND actor_user_id = u1), 2, 'password: the number of revoked keys is audited');
END
$$;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
SELECT set_config('app.user_id', '', true) \g /dev/null
DO $$
BEGIN
    PERFORM pg_temp.assert_raises('SELECT fn_web_password_hash()', '42501', 'password: no user context, no hash');
    PERFORM pg_temp.assert_raises('SELECT fn_web_set_password(''$2b$12$'' || repeat(''z'', 53), digest(''x'', ''sha256''), 60, NULL, NULL)', '42501', 'password: no user context, no change');
END
$$;
RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- API-ключи
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1');
BEGIN
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (u1, 'ok', 'gr_okkkk', digest('key-ok', 'sha256'));
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash, revoked_at) VALUES (u1, 'revoked', 'gr_revok', digest('key-revoked', 'sha256'), now());
    INSERT INTO api_keys (user_id, name, key_prefix, key_hash, expires_at, created_at)
    VALUES (u1, 'expired', 'gr_expir', digest('key-expired', 'sha256'), now() - interval '1 hour', now() - interval '2 hours');
END
$$;
SELECT set_config('app.user_id', '', true), set_config('app.user_role', '', true) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    r record;
BEGIN
    SELECT * INTO r FROM fn_find_api_key(digest('key-ok', 'sha256'));
    PERFORM pg_temp.assert_eq(r.o_user_id, pg_temp.fx('u1'), 'api key: found without any user context, returns the owner');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM fn_find_api_key(digest('key-revoked', 'sha256'))), 'api key: revoked key is not found');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM fn_find_api_key(digest('key-expired', 'sha256'))), 'api key: expired key is not found');
    PERFORM pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM fn_find_api_key(digest('key-unknown', 'sha256'))), 'api key: unknown key is not found');
END
$$;
RESET ROLE;
DO $$
BEGIN
    PERFORM pg_temp.assert_true((SELECT last_used_at IS NOT NULL FROM api_keys WHERE key_hash = digest('key-ok', 'sha256')), 'api key: last_used_at is set on use');
    UPDATE api_keys SET last_used_at = now() - interval '10 seconds' WHERE key_hash = digest('key-ok', 'sha256');
    PERFORM 1 FROM fn_find_api_key(digest('key-ok', 'sha256'));
    PERFORM pg_temp.assert_true((SELECT last_used_at < now() - interval '5 seconds' FROM api_keys WHERE key_hash = digest('key-ok', 'sha256')),
                                'api key: last_used_at is refreshed at most once a minute');
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Биллинг при обращении: начисляет только текущему пользователю и только за интервалы длиннее минуты
-- ---------------------------------------------------------------------------------------------
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2'); i1 uuid; i2 uuid;
BEGIN
    PERFORM pg_temp.no_storage();
    i1 := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'bill-u1');
    i2 := fn_start_instance(u2, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'bill-u2');
    PERFORM pg_temp.age_instance(i1, interval '2 hours');
    PERFORM pg_temp.age_instance(i2, interval '2 hours');
    PERFORM set_config('fx.bi1', i1::text, true);
    PERFORM set_config('fx.bi2', i2::text, true);
    PERFORM set_config('fx.bal1', (SELECT balance FROM users WHERE id = u1)::text, true);
    PERFORM set_config('fx.bal2', (SELECT balance FROM users WHERE id = u2)::text, true);
END
$$;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    r record;
BEGIN
    SELECT * INTO r FROM fn_bill_current_user();
    PERFORM pg_temp.assert_eq(r.o_usage_rows, 1, 'bill at access: one usage record for the running instance of the caller');
    PERFORM pg_temp.assert_true(r.o_amount BETWEEN 199.9 AND 200.1, 'bill at access: two hours at 100 RUB/h are charged');
    PERFORM pg_temp.assert_eq(r.o_stopped, 0, 'bill at access: nobody is stopped while the balance is positive');
    SELECT * INTO r FROM fn_bill_current_user();
    PERFORM pg_temp.assert_eq(r.o_usage_rows, 0, 'bill at access: an immediate repeat creates no records (interval shorter than a minute)');
END
$$;
RESET ROLE;
DO $$
BEGIN
    PERFORM pg_temp.assert_true((SELECT pg_temp.fxt('bal1')::numeric - balance BETWEEN 199.9 AND 200.1 FROM users WHERE id = pg_temp.fx('u1')), 'bill at access: the balance of the caller dropped by the charge');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = pg_temp.fx('u2')), pg_temp.fxt('bal2')::numeric, 'bill at access: the balance of another user is untouched');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id = pg_temp.fxt('bi2')::uuid), 0, 'bill at access: the instance of another user is not billed');
END
$$;
-- роль приложения без пользовательского контекста биллить «при обращении» не может
SELECT set_config('app.user_id', '', true), set_config('app.user_role', '', true) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_bill_current_user()', '42501', 'bill at access: needs a user context');
END
$$;
RESET ROLE;
-- баланс <= 0 после начисления: автостоп, как в проходе биллинга
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u2 bigint := pg_temp.fx('u2');
BEGIN
    INSERT INTO transactions (user_id, type, amount, description) VALUES (u2, 'adjustment', -(SELECT balance FROM users WHERE id = u2) + 50, 'drain');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u2), 50::numeric, 'fixture: u2 has only 50 RUB left');
END
$$;
SELECT pg_temp.as_user(pg_temp.fx('u2')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    r record;
BEGIN
    SELECT * INTO r FROM fn_bill_current_user();
    PERFORM pg_temp.assert_eq(r.o_stopped, 1, 'bill at access: the instance is stopped when the charge exhausts the balance');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = pg_temp.fxt('bi2')::uuid), 'stopped', 'bill at access: status is stopped');
END
$$;
RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- Уведомления шлюза: сверка суммы, идемпотентное зачисление
-- ---------------------------------------------------------------------------------------------
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1');
BEGIN
    INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (u1, 'demo', 'pay-ok', 500.00), (u1, 'demo', 'pay-fail', 300.00);
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_payment_confirm(''demo'', ''pay-ok'', ''succeeded'', 500)', '42501', 'payment: a client context cannot confirm payments');
END
$$;
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); r record; v_before numeric;
BEGIN
    SELECT balance INTO v_before FROM users WHERE id = u1;
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_payment_confirm(''demo'', ''pay-ok'', ''succeeded'', 499)', 'GR005', 'payment: amount mismatch is rejected');
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_payment_confirm(''demo'', ''pay-none'', ''succeeded'', 500)', 'GR004', 'payment: unknown payment is rejected');
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_payment_confirm(''demo'', ''pay-ok'', ''refunded'', 500)', 'GR005', 'payment: unsupported status is rejected');

    SELECT * INTO r FROM fn_payment_confirm('demo', 'pay-ok', 'succeeded', 500);
    PERFORM pg_temp.assert_eq(r.o_credited, true, 'payment: the first notification credits the balance');
    PERFORM pg_temp.assert_eq(r.o_status::text, 'succeeded', 'payment: status is succeeded');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), v_before + 500, 'payment: balance grew by the amount');
    SELECT * INTO r FROM fn_payment_confirm('demo', 'pay-ok', 'succeeded', 500);
    PERFORM pg_temp.assert_eq(r.o_credited, false, 'payment: a repeated notification does not credit again');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), v_before + 500, 'payment: balance is unchanged after the repeat');
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_payment_confirm(''demo'', ''pay-ok'', ''failed'', 500)', 'GR003', 'payment: a paid payment cannot be failed');

    SELECT * INTO r FROM fn_payment_confirm('demo', 'pay-fail', 'failed', 300);
    PERFORM pg_temp.assert_eq(r.o_status::text, 'failed', 'payment: failed notification marks the payment failed');
    PERFORM pg_temp.assert_eq(r.o_credited, false, 'payment: failed payment is not credited');
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_payment_confirm(''demo'', ''pay-fail'', ''succeeded'', 300)', 'GR003', 'payment: a failed payment cannot be credited later');
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Блокировка пользователей
-- ---------------------------------------------------------------------------------------------
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_raises(format('SELECT fn_admin_set_user_status(%s, ''blocked'')', pg_temp.fx('u2')), '42501', 'admin: a client cannot block users');
END
$$;
RESET ROLE;
SELECT pg_temp.as_user(pg_temp.fx('adm'), 'admin') \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    u2 bigint := pg_temp.fx('u2'); adm bigint := pg_temp.fx('adm');
BEGIN
    PERFORM fn_admin_set_user_status(u2, 'blocked');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM users WHERE id = u2), 'blocked', 'admin: the user is blocked');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit_log WHERE action = 'user.status_changed' AND entity_id = u2::text AND actor_user_id = adm), 1,
                              'admin: the block is written to audit_log with the administrator as the actor');
    PERFORM fn_admin_set_user_status(u2, 'active');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM users WHERE id = u2), 'active', 'admin: the user is unblocked');
    PERFORM pg_temp.assert_raises(format('SELECT fn_admin_set_user_status(%s, ''blocked'')', adm), 'GR003', 'admin: an administrator cannot block himself');
    PERFORM pg_temp.assert_raises('SELECT fn_admin_set_user_status(999999999, ''blocked'')', 'GR004', 'admin: unknown user gives GR004');
END
$$;
RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- Сужение прав на users и RLS
-- ---------------------------------------------------------------------------------------------
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2');
BEGIN
    PERFORM pg_temp.assert_raises('SELECT password_hash FROM users', '42501', 'users: password_hash is not readable by the app role');
    PERFORM pg_temp.assert_raises('SELECT * FROM users', '42501', 'users: SELECT * is not allowed (it includes password_hash)');
    PERFORM pg_temp.assert_raises(format('UPDATE users SET role = ''admin'' WHERE id = %s', u1), '42501', 'users: a client cannot make himself an administrator');
    PERFORM pg_temp.assert_raises(format('UPDATE users SET status = ''blocked'' WHERE id = %s', u2), '42501', 'users: status cannot be changed directly');
    PERFORM pg_temp.assert_raises(format('UPDATE users SET password_hash = ''$2b$12$'' || repeat(''x'', 53) WHERE id = %s', u2), '42501', 'users: password_hash cannot be changed directly');
    PERFORM pg_temp.assert_raises('INSERT INTO users (email, password_hash, full_name) VALUES (''direct@example.test'', ''$2b$12$'' || repeat(''x'', 53), ''X'')', '42501', 'users: direct INSERT is closed, registration goes through fn_web_register');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM users), 1, 'users: a client sees only his own row (RLS)');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM users WHERE id = u2), 0, 'users: the row of another user is invisible even by an explicit filter');
    PERFORM pg_temp.assert_eq((SELECT email FROM users), 'tst-u1@example.test'::citext, 'users: own columns are readable');
END
$$;
RESET ROLE;
SELECT pg_temp.as_user(pg_temp.fx('adm'), 'admin') \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_true((SELECT count(*) FROM users) >= 5, 'users: an administrator sees every user');
END
$$;
RESET ROLE;
SELECT set_config('app.user_id', '', true), set_config('app.user_role', '', true) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM users), 0, 'users: without a context the table looks empty');
END
$$;
RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- Шаблоны: RLS
-- ---------------------------------------------------------------------------------------------
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2'); v_tpl bigint; n int;
BEGIN
    INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (u1, 'u1-private', 'u1/img', 20, false) RETURNING id INTO v_tpl;
    PERFORM set_config('fx.tpl_u1', v_tpl::text, true);
    PERFORM pg_temp.assert_raises(format('INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (%s, ''for-u2'', ''x'', 20, false)', u2),
                                  '42501', 'templates: u1 cannot create a template owned by u2');
    PERFORM pg_temp.assert_raises('INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (NULL, ''fake-public'', ''x'', 20, true)',
                                  '42501', 'templates: a client cannot create a public template');
    -- Публиковать «от своего имени» тоже нельзя: правило «публичный ⇔ без владельца» держит CHECK, а не политика.
    PERFORM pg_temp.assert_raises(format('INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (%s, ''own-public'', ''x'', 20, true)', u1),
                                  '23514', 'templates: a client cannot create a public template under own id (CHECK ck_templates_public_owner)');
    PERFORM pg_temp.assert_raises(format('UPDATE templates SET is_public = true WHERE id = %s', v_tpl),
                                  '23514', 'templates: the owner cannot make own template public');
    PERFORM pg_temp.assert_raises(format('UPDATE templates SET owner_id = NULL WHERE id = %s', v_tpl),
                                  '42501', 'templates: the owner cannot orphan own template (WITH CHECK)');
    UPDATE templates SET name = 'renamed' WHERE id = v_tpl;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 1, 'templates: the owner can rename own template');
    UPDATE templates SET name = 'hacked' WHERE id = pg_temp.fx('tpl');
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'templates: a client cannot change a public template');
    DELETE FROM templates WHERE id = pg_temp.fx('tpl');
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'templates: a client cannot delete a public template');
    UPDATE templates SET owner_id = u1, is_public = false WHERE id = pg_temp.fx('tpl');
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'templates: a public template cannot be taken over by changing owner_id');
    PERFORM pg_temp.assert_raises(format('UPDATE templates SET owner_id = %s WHERE id = %s', u2, pg_temp.fx('tpl_u1')),
                                  '42501', 'templates: the owner cannot hand a template over to another user (WITH CHECK)');
END
$$;
RESET ROLE;
SELECT pg_temp.as_user(pg_temp.fx('u2')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    n int;
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM templates WHERE name LIKE 'u1-%' OR name = 'renamed'), 0, 'templates: the private template of u1 is invisible to u2');
    UPDATE templates SET name = 'hacked' WHERE id = pg_temp.fx('tpl_u1');
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'templates: u2 cannot change the template of u1');
    DELETE FROM templates WHERE id = pg_temp.fx('tpl_u1');
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'templates: u2 cannot delete the template of u1');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM templates WHERE is_public) >= 1, 'templates: public templates are visible to everyone');
END
$$;
RESET ROLE;
SELECT set_config('app.user_id', '', true), set_config('app.user_role', '', true) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_true((SELECT count(*) FROM templates WHERE is_public) >= 1, 'templates: an anonymous caller sees the public catalog');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM templates WHERE NOT is_public), 0, 'templates: an anonymous caller sees no private template');
END
$$;
RESET ROLE;
SELECT pg_temp.as_user(pg_temp.fx('adm'), 'admin') \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, is_public) VALUES (NULL, 'admin-public', 'x', 20, true);
    PERFORM pg_temp.ok('templates: an administrator can create a public template');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM templates WHERE NOT is_public) >= 1, 'templates: an administrator sees private templates');
END
$$;
RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- Обслуживание
-- ---------------------------------------------------------------------------------------------
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_raises('SELECT * FROM fn_web_cleanup()', '42501', 'cleanup: not available to a client');
    PERFORM pg_temp.assert_raises('SELECT fn_billing_run_done(''{}'')', '42501', 'billing run log: not available to a client');
    PERFORM pg_temp.assert_true(fn_last_billing_at() IS NULL, 'last billing: NULL before the first pass');
END
$$;
RESET ROLE;
INSERT INTO sessions (user_id, token_hash, created_at, expires_at)
VALUES (pg_temp.fx('u1'), digest('sess-cleanup', 'sha256'), now() - interval '9 days', now() - interval '2 days');
SELECT pg_temp.as_system() \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    r record;
BEGIN
    PERFORM fn_billing_run_done('{"users": 1}');
    PERFORM pg_temp.assert_true(fn_last_billing_at() > now() - interval '1 minute', 'last billing: set after the pass is logged');
    SELECT * INTO r FROM fn_web_cleanup();
    PERFORM pg_temp.assert_true(r.o_sessions >= 1, 'cleanup: expired sessions are removed');
    PERFORM pg_temp.assert_true(r.o_attempts >= 0 AND r.o_tokens >= 0 AND r.o_runs = 0, 'cleanup: fresh records stay');
END
$$;
RESET ROLE;
DO $$
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM sessions WHERE expires_at < now()), 0, 'cleanup: no expired sessions left');
END
$$;

ROLLBACK;

-- 05: fn_topup: идемпотентное зачисление платежа, отказ для неуспешных платежей, права вызова.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u3 bigint := pg_temp.fx('u3'); u2 bigint := pg_temp.fx('u2');
    p1 bigint; p2 bigint; p_failed bigint; p_refunded bigint; p_missing bigint := 987654321;
    b2 numeric; i int;
BEGIN
    INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (u3, 'yookassa', 'yk-1', 500.50) RETURNING id INTO p1;
    SELECT balance INTO b2 FROM users WHERE id = u2;

    PERFORM pg_temp.assert_eq(fn_topup(p1), true, 'first fn_topup credits the payment');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u3), 500.5000, 'balance increased by the payment amount');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM payments WHERE id = p1), 'succeeded', 'pending payment became succeeded');
    PERFORM pg_temp.assert_true((SELECT paid_at IS NOT NULL FROM payments WHERE id = p1), 'paid_at is set');

    PERFORM pg_temp.assert_eq(fn_topup(p1), false, 'second fn_topup for the same payment returns false');
    FOR i IN 1..10 LOOP PERFORM fn_topup(p1); END LOOP;
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u3), 500.5000, 'repeated calls do not change the balance');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM transactions WHERE payment_id = p1 AND type = 'topup'), 1, 'exactly one topup transaction per payment');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u2), b2, 'other users are untouched');

    -- webhook уже перевёл платёж в succeeded, а зачисление не состоялось -> fn_topup доводит его ровно один раз
    INSERT INTO payments (user_id, provider, provider_payment_id, amount, status, paid_at) VALUES (u3, 'yookassa', 'yk-2', 100, 'succeeded', now()) RETURNING id INTO p2;
    PERFORM pg_temp.assert_eq(fn_topup(p2), true, 'succeeded payment without a ledger row is credited');
    PERFORM pg_temp.assert_eq(fn_topup(p2), false, '... and only once');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u3), 600.5000, 'balance is 500.50 + 100');

    -- неуспешные платежи не зачисляются
    INSERT INTO payments (user_id, provider, provider_payment_id, amount, status) VALUES (u3, 'yookassa', 'yk-3', 10, 'failed') RETURNING id INTO p_failed;
    INSERT INTO payments (user_id, provider, provider_payment_id, amount, status, paid_at) VALUES (u3, 'yookassa', 'yk-4', 10, 'refunded', now()) RETURNING id INTO p_refunded;
    PERFORM pg_temp.assert_raises(format('SELECT fn_topup(%s)', p_failed), 'GR003', 'failed payment cannot be credited');
    PERFORM pg_temp.assert_raises(format('SELECT fn_topup(%s)', p_refunded), 'GR003', 'refunded payment cannot be credited');
    PERFORM pg_temp.assert_raises(format('SELECT fn_topup(%s)', p_missing), 'GR004', 'unknown payment is refused');

    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u3), (SELECT sum(amount) FROM transactions WHERE user_id = u3), 'balance equals SUM(transactions)');

    -- зачисление на заблокированного пользователя допустимо: деньги клиента не пропадают
    UPDATE users SET status = 'blocked' WHERE id = u3;
    INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (u3, 'yookassa', 'yk-5', 1) RETURNING id INTO p1;
    PERFORM pg_temp.assert_eq(fn_topup(p1), true, 'blocked user can still be credited');

    -- права вызова
    PERFORM pg_temp.as_user(u3);
    PERFORM pg_temp.assert_raises(format('SELECT fn_topup(%s)', p1), '42501', 'client context cannot call fn_topup');
    PERFORM pg_temp.as_user(pg_temp.fx('adm'), 'admin');
    PERFORM pg_temp.assert_eq(fn_topup(p1), false, 'admin context may call fn_topup');
END
$$;
ROLLBACK;

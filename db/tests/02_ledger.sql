-- 02: журнал операций: неизменяемость, баланс = SUM(transactions), прямой UPDATE баланса запрещён,
-- согласованность знака и типа, идемпотентность пополнения на уровне индексов.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql

DO $$
BEGIN
    PERFORM pg_temp.assert_raises('UPDATE transactions SET description = ''x''', '23001', 'UPDATE of ledger rows is rejected');
    PERFORM pg_temp.assert_raises('DELETE FROM transactions', '23001', 'DELETE of ledger rows is rejected');
    PERFORM pg_temp.assert_raises('TRUNCATE transactions', '23001', 'TRUNCATE transactions is rejected');
    PERFORM pg_temp.assert_raises('TRUNCATE usage_records, transactions', '23001', 'TRUNCATE usage_records (with its referrer) is rejected');
    PERFORM pg_temp.assert_raises('TRUNCATE audit_log', '23001', 'TRUNCATE audit_log is rejected');
    PERFORM pg_temp.assert_raises('UPDATE audit_log SET action = ''x''', '23001', 'UPDATE of audit_log is rejected');
    PERFORM pg_temp.assert_raises('DELETE FROM audit_log', '23001', 'DELETE from audit_log is rejected');
END
$$;

-- Баланс — инкрементальный кэш журнала.
DO $$
DECLARE
    v_u1 bigint := pg_temp.fx('u1');
BEGIN
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = v_u1), 10000.0000, 'fixture balance equals the topup');

    INSERT INTO transactions (user_id, type, amount, description) VALUES (v_u1, 'bonus', 50.5, 'welcome');
    INSERT INTO transactions (user_id, type, amount, description) VALUES (v_u1, 'adjustment', -20.25, 'correction');
    INSERT INTO transactions (user_id, type, amount, description) VALUES (v_u1, 'adjustment', 5, 'correction +');

    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = v_u1),
                              (SELECT sum(amount) FROM transactions WHERE user_id = v_u1),
                              'balance equals SUM(transactions) after several operations');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = v_u1), 10035.2500, 'balance value is 10000 + 50.5 - 20.25 + 5');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = pg_temp.fx('u3')), 0.0000, 'user without operations has zero balance');
END
$$;

-- Прямое изменение баланса запрещено триггером даже для суперпользователя.
DO $$
BEGIN
    PERFORM pg_temp.assert_raises(format('UPDATE users SET balance = balance + 1 WHERE id = %s', pg_temp.fx('u1')),
                                  '23001', 'direct UPDATE users.balance (+1) is rejected');
    PERFORM pg_temp.assert_raises(format('UPDATE users SET balance = 0 WHERE id = %s', pg_temp.fx('u1')),
                                  '23001', 'direct UPDATE users.balance (reset) is rejected');
    PERFORM pg_temp.assert_raises(
        'INSERT INTO users (email, password_hash, full_name, balance) VALUES (''tst-rich@example.test'', ''$2b$12$'' || repeat(''x'', 53), ''Богатый'', 1000)',
        '23001', 'user cannot be created with non-zero balance');
    -- правка профиля проходит и balance не затрагивает
    UPDATE users SET full_name = 'Иванов Иван' WHERE id = pg_temp.fx('u1');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = pg_temp.fx('u1')), 10035.2500, 'profile update leaves balance untouched');
END
$$;

-- Согласованность знака и типа, обязательные ссылки.
DO $$
DECLARE
    v text := pg_temp.fxt('u1');
BEGIN
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount, payment_id) VALUES (%s, ''topup'', -5, 1)', v), '23514', 'negative topup is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount) VALUES (%s, ''topup'', 5)', v), '23514', 'topup without payment is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount) VALUES (%s, ''charge'', 5)', v), '23514', 'positive charge is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount) VALUES (%s, ''charge'', -5)', v), '23514', 'charge without usage reference is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount, usage_id, usage_period_start) VALUES (%s, ''charge'', -5, 999999, now())', v), '23503', 'charge referencing a non-existent usage record is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount) VALUES (%s, ''refund'', 5)', v), '23514', 'positive refund is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount) VALUES (%s, ''bonus'', -5)', v), '23514', 'negative bonus is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount) VALUES (%s, ''adjustment'', 0)', v), '23514', 'zero adjustment is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount) VALUES (%s, ''bonus'', ''NaN'')', v), '23514', 'NaN amount is rejected');
    PERFORM pg_temp.assert_raises(format('INSERT INTO transactions (user_id, type, amount, usage_id) VALUES (%s, ''bonus'', 1, 1)', v), '23514', 'non-charge row must not reference usage');
END
$$;

-- Платежи: идемпотентность webhook и согласованная разрядность.
DO $$
DECLARE
    v_pay bigint;
BEGIN
    INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (pg_temp.fx('u1'), 'yookassa', 'dup-1', 500) RETURNING id INTO v_pay;
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (%s, ''yookassa'', ''dup-1'', 500)', pg_temp.fx('u1')),
        '23505', 'second payment row with the same provider payment id is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (%s, ''yookassa'', ''big'', 10000000000)', pg_temp.fx('u1')),
        '23514', 'payment amount that would not fit the ledger is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO payments (user_id, provider, provider_payment_id, amount) VALUES (%s, ''yookassa'', ''zero'', 0)', pg_temp.fx('u1')),
        '23514', 'zero payment is rejected');
    PERFORM pg_temp.assert_raises(
        format('UPDATE payments SET amount = 1 WHERE id = %s', v_pay), '23001', 'payment amount is immutable');
    PERFORM pg_temp.assert_raises(
        format('UPDATE payments SET status = ''refunded'', paid_at = now() WHERE id = %s', v_pay), '23001', 'pending payment cannot jump to refunded');

    -- два зачисления одного платежа запрещены на уровне индекса, а не только логики функции
    UPDATE payments SET status = 'succeeded', paid_at = now() WHERE id = v_pay;
    INSERT INTO transactions (user_id, type, amount, payment_id) VALUES (pg_temp.fx('u1'), 'topup', 500, v_pay);
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO transactions (user_id, type, amount, payment_id) VALUES (%s, ''topup'', 500, %s)', pg_temp.fx('u1'), v_pay),
        '23505', 'second topup for one payment is rejected by the unique index');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = pg_temp.fx('u1')),
                              (SELECT sum(amount) FROM transactions WHERE user_id = pg_temp.fx('u1')),
                              'balance still equals SUM(transactions) after the rejected duplicates');
END
$$;

ROLLBACK;

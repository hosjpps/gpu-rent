-- 04: биллинг-проход fn_bill_usage: точная сумма, идемпотентность на тот же момент, граница не идёт назад,
-- связь charge -> usage_records, хранение томов, автостоп при балансе <= 0, права вызова.
-- Проход затрагивает всех пользователей БД (и сидовых тоже), поэтому проверки привязаны к пользователям фикстуры.

-- ===== A. Посекундный расчёт и идемпотентность ==========================================================
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.no_storage(), pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1');
    v_id uuid; t0 timestamptz; res record; v_bal numeric; v_rows int;
BEGIN
    v_id := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 2, 'on_demand', pg_temp.fx('tpl'), 'bill');  -- 200 RUB/h
    PERFORM pg_temp.age_instance(v_id, interval '1 hour');
    SELECT last_billed_at INTO t0 FROM instances WHERE id = v_id;

    PERFORM pg_temp.as_system();
    SELECT * INTO res FROM fn_bill_usage(t0 + interval '1 hour');
    PERFORM pg_temp.assert_eq((SELECT quantity FROM usage_records WHERE instance_id = v_id), 3600::numeric, 'usage quantity is 3600 seconds');
    PERFORM pg_temp.assert_eq((SELECT amount FROM usage_records WHERE instance_id = v_id), 200.0000, 'one hour of a 200 RUB/h instance costs exactly 200');
    PERFORM pg_temp.assert_eq((SELECT -sum(amount) FROM transactions WHERE user_id = u1 AND type = 'charge'), 200.0000, 'charge transaction equals the usage amount');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), 9800.0000, 'balance is 10000 - 200');
    PERFORM pg_temp.assert_eq((SELECT last_billed_at FROM instances WHERE id = v_id), t0 + interval '1 hour', 'last_billed_at moved to the cutoff');
    PERFORM pg_temp.assert_true(res.o_usage_rows >= 1 AND res.o_amount >= 200, 'pass result reports the billed amount');

    -- повторный проход на тот же момент
    SELECT count(*) INTO v_rows FROM usage_records WHERE instance_id = v_id;
    SELECT balance INTO v_bal FROM users WHERE id = u1;
    PERFORM fn_bill_usage(t0 + interval '1 hour');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id = v_id), v_rows, 'repeated pass at the same moment creates no usage records');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), v_bal, 'repeated pass at the same moment charges nothing');

    -- граница не двигается назад
    PERFORM fn_bill_usage(t0 + interval '30 minutes');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id = v_id), v_rows, 'a pass with an earlier cutoff does nothing');
    PERFORM pg_temp.assert_eq((SELECT last_billed_at FROM instances WHERE id = v_id), t0 + interval '1 hour', 'last_billed_at never moves back');
    PERFORM pg_temp.assert_eq(_fn_bill_instance(v_id, t0 + interval '10 minutes'), 0::numeric, 'internal helper: an interval that ends before last_billed_at bills nothing');

    -- следующий интервал начинается ровно там, где закончился предыдущий
    PERFORM fn_bill_usage(t0 + interval '1 hour 90 seconds');
    PERFORM pg_temp.assert_eq((SELECT amount FROM usage_records WHERE instance_id = v_id AND period_start = t0 + interval '1 hour'), 5.0000, '90 seconds of 200 RUB/h = 5.0000');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id = v_id), 2, 'second pass added exactly one record');

    -- округление до 4 знаков: 1 секунда по 200 RUB/h = 0.05555... -> 0.0556
    PERFORM fn_bill_usage(t0 + interval '1 hour 91 seconds');
    PERFORM pg_temp.assert_eq((SELECT amount FROM usage_records WHERE instance_id = v_id AND period_start = t0 + interval '1 hour 90 seconds'), 0.0556, 'one second is rounded to 4 decimals (0.0556)');

    -- интервал дешевле 0.0001 не списывается и границу не двигает
    PERFORM fn_bill_usage(t0 + interval '1 hour 91 seconds 100 microseconds');
    PERFORM pg_temp.assert_eq((SELECT last_billed_at FROM instances WHERE id = v_id), t0 + interval '1 hour 91 seconds', 'a 100 microsecond interval (< 0.0001 RUB) is deferred, not lost');
    PERFORM fn_bill_usage(t0 + interval '2 hours');
    PERFORM pg_temp.assert_eq((SELECT sum(quantity) FROM usage_records WHERE instance_id = v_id), 7200::numeric, 'deferred time is billed by the next pass: 7200 seconds in total');
    PERFORM pg_temp.assert_true(abs((SELECT sum(amount) FROM usage_records WHERE instance_id = v_id) - 400) < 0.001, 'two hours cost 400 (rounding error below 0.001)');

    -- интервалы идут встык
    PERFORM pg_temp.assert_true(
        (SELECT bool_and(period_start = prev_end) FROM (SELECT period_start, lag(period_end) OVER (ORDER BY period_start) AS prev_end
                                                        FROM usage_records WHERE instance_id = v_id) s WHERE prev_end IS NOT NULL),
        'billed intervals are contiguous: no gaps, no overlaps');

    -- каждому списанию соответствует своё потребление на ту же сумму
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM transactions t
                               JOIN usage_records u ON u.id = t.usage_id AND u.period_start = t.usage_period_start
                               WHERE t.user_id = u1 AND t.type = 'charge' AND t.amount = -u.amount),
                              (SELECT count(*)::int FROM transactions WHERE user_id = u1 AND type = 'charge'),
                              'every charge points to a usage record with the same amount');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), (SELECT sum(amount) FROM transactions WHERE user_id = u1),
                              'balance equals SUM(transactions) after billing passes');

    -- одно потребление — одно списание; один интервал объекта — одна запись
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO transactions (user_id, type, amount, usage_id, usage_period_start) SELECT user_id, ''charge'', -amount, id, period_start FROM usage_records WHERE instance_id = %L LIMIT 1', v_id),
        '23505', 'second charge for the same usage record is rejected');
    PERFORM pg_temp.assert_raises(
        format('INSERT INTO usage_records (user_id, instance_id, kind, period_start, period_end, quantity, amount) SELECT user_id, instance_id, kind, period_start, period_end + interval ''1 second'', 1, 1 FROM usage_records WHERE instance_id = %L LIMIT 1', v_id),
        '23505', 'second usage record starting at the same moment for the same instance is rejected');
    PERFORM pg_temp.assert_raises('UPDATE usage_records SET amount = 0', '23001', 'usage_records is append-only');

    -- права вызова
    PERFORM pg_temp.as_user(u1);
    PERFORM pg_temp.assert_raises('SELECT fn_bill_usage()', '42501', 'client context cannot run the billing pass');
END
$$;
ROLLBACK;

-- ===== B. Хранение томов ================================================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); vol bigint := pg_temp.fx('vol1'); t0 timestamptz;
BEGIN
    UPDATE volumes SET created_at = created_at - interval '3 hours', last_billed_at = last_billed_at - interval '3 hours' WHERE id = vol;
    SELECT last_billed_at INTO t0 FROM volumes WHERE id = vol;

    PERFORM fn_bill_usage(t0 + interval '1 hour');
    PERFORM pg_temp.assert_eq((SELECT kind::text FROM usage_records WHERE volume_id = vol), 'storage', 'storage usage is recorded with kind=storage');
    PERFORM pg_temp.assert_eq((SELECT quantity FROM usage_records WHERE volume_id = vol), 360000::numeric, 'quantity is 100 GB * 3600 s = 360000 GB*s');
    PERFORM pg_temp.assert_eq((SELECT amount FROM usage_records WHERE volume_id = vol), 2.5000, '100 GB for 1 hour at 18 RUB/GB-month = 2.5 RUB');
    PERFORM pg_temp.assert_eq((SELECT amount FROM transactions WHERE user_id = u1 AND type = 'charge'), -2.5000, 'storage charge is written to the ledger');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), 9997.5000, 'balance reflects the storage charge');

    PERFORM fn_bill_usage(t0 + interval '1 hour');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE volume_id = vol), 1, 'repeated pass does not bill the volume twice');

    -- удалённый том дотарифицируется до момента удаления и дальше не начисляется
    UPDATE volumes SET status = 'deleted', deleted_at = t0 + interval '90 minutes' WHERE id = vol;
    PERFORM fn_bill_usage(t0 + interval '3 hours');
    PERFORM pg_temp.assert_eq((SELECT sum(amount) FROM usage_records WHERE volume_id = vol), 3.7500, 'deleted volume is billed up to deleted_at (1.5 h = 3.75 RUB)');
    PERFORM fn_bill_usage(t0 + interval '5 hours');
    PERFORM pg_temp.assert_eq((SELECT sum(amount) FROM usage_records WHERE volume_id = vol), 3.7500, 'nothing is billed after deletion');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), (SELECT sum(amount) FROM transactions WHERE user_id = u1), 'balance equals SUM(transactions)');
END
$$;
ROLLBACK;

-- ===== C. Автостоп при балансе <= 0 ====================================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.no_storage() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2');
    dc1 bigint := pg_temp.fx('dc1'); ma bigint := pg_temp.fx('ma');
    a uuid; b uuid; c uuid; cut timestamptz; res record;
BEGIN
    -- u1: два инстанса (200 + 100 RUB/h), баланс урезан до 100 -> за час уйдёт в минус
    PERFORM pg_temp.as_user(u1);
    a := fn_start_instance(u1, dc1, ma, 2, 'on_demand', pg_temp.fx('tpl'), 'a');
    b := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'b');
    INSERT INTO transactions (user_id, type, amount, description) VALUES (u1, 'adjustment', -9900, 'leave 100');
    -- u2: один спот-инстанс (50 RUB/h) и ровно 50 RUB: после часа баланс ровно 0
    PERFORM pg_temp.as_user(u2);
    c := fn_start_instance(u2, dc1, ma, 1, 'spot', pg_temp.fx('tpl'), 'c');   -- 50 RUB/h
    INSERT INTO transactions (user_id, type, amount, description) VALUES (u2, 'adjustment', -9950, 'leave 50');

    PERFORM pg_temp.age_instance(a, interval '1 hour');
    PERFORM pg_temp.age_instance(b, interval '1 hour');
    PERFORM pg_temp.age_instance(c, interval '1 hour');
    -- граница = ровно час для c (итог 0.0000), для a и b — чуть больше часа
    SELECT last_billed_at + interval '1 hour' INTO cut FROM instances WHERE id = c;

    PERFORM pg_temp.as_system();
    SELECT * INTO res FROM fn_bill_usage(cut);

    PERFORM pg_temp.assert_true((SELECT balance FROM users WHERE id = u1) < 0, 'u1 balance went negative after the pass');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = a), 'stopped', 'autostop: instance a is stopped');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = b), 'stopped', 'autostop: instance b of the same user is stopped too');
    PERFORM pg_temp.assert_eq((SELECT stopped_at FROM instances WHERE id = a), cut, 'autostop: stopped_at equals the billing cutoff');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_gpus WHERE instance_id IN (a, b) AND upper_inf(allocated_during)), 0, 'autostop: GPUs are released');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM audit_log WHERE action = 'instance.autostop_low_balance' AND entity_id IN (a::text, b::text)), 2, 'autostop: a notification record is written per instance');

    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u2), 0.0000, 'u2 balance dropped to exactly zero');
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = c), 'stopped', 'autostop also fires at balance exactly 0');
    PERFORM pg_temp.assert_true(res.o_stopped >= 3, 'pass result counts stopped instances');

    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), (SELECT sum(amount) FROM transactions WHERE user_id = u1), 'u1: balance equals SUM(transactions)');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u2), (SELECT sum(amount) FROM transactions WHERE user_id = u2), 'u2: balance equals SUM(transactions)');

    -- после автостопа проход ничего не делает, а остановленный инстанс с долгом не запускается
    PERFORM fn_bill_usage(cut);
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id IN (a, b, c)), 3, 'no extra usage after autostop');
    PERFORM pg_temp.as_user(u1);
    PERFORM pg_temp.assert_raises(format('SELECT fn_resume_instance(%L)', a), 'GR002', 'resume with negative balance is refused');
END
$$;
ROLLBACK;

-- ===== D. Автостоп не трогает платёжеспособных ==========================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.no_storage() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); a uuid; cut timestamptz;
BEGIN
    PERFORM pg_temp.as_user(u1);
    a := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'rich');
    PERFORM pg_temp.age_instance(a, interval '2 hours');
    SELECT last_billed_at + interval '2 hours' INTO cut FROM instances WHERE id = a;
    PERFORM pg_temp.as_system();
    PERFORM fn_bill_usage(cut);
    PERFORM pg_temp.assert_eq((SELECT status::text FROM instances WHERE id = a), 'running', 'instance of a solvent user keeps running');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u1), 9800.0000, 'two hours at 100 RUB/h were charged');
END
$$;
ROLLBACK;

-- ===== E. Проход по одному пользователю ================================================================
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.no_storage() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2'); a uuid; b uuid; t0 timestamptz; res record;
BEGIN
    PERFORM pg_temp.as_user(u1);
    a := fn_start_instance(u1, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'one');
    PERFORM pg_temp.as_user(u2);
    b := fn_start_instance(u2, pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'two');
    PERFORM pg_temp.age_instance(a, interval '1 hour');
    PERFORM pg_temp.age_instance(b, interval '1 hour');
    SELECT greatest(i1.last_billed_at, i2.last_billed_at) + interval '1 hour' INTO t0
    FROM instances i1, instances i2 WHERE i1.id = a AND i2.id = b;

    PERFORM pg_temp.as_system();
    SELECT * INTO res FROM fn_bill_usage(t0, u1);
    PERFORM pg_temp.assert_eq(res.o_users, 1, 'p_user_id: exactly one user was processed');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id = a), 1, 'p_user_id: the requested user was billed');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id = b), 0, 'p_user_id: the other user was not touched');
    PERFORM pg_temp.assert_eq((SELECT balance FROM users WHERE id = u2), 10000.0000, 'p_user_id: balance of the other user is unchanged');
    PERFORM fn_bill_usage(t0, u2);
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM usage_records WHERE instance_id = b), 1, 'p_user_id: the second user is billed by his own call');
END
$$;
ROLLBACK;

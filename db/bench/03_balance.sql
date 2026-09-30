-- Бенчмарк (в): текущий баланс пользователя — сумма журнала против денормализованного users.balance.
--   A) SUM(amount) по transactions без индекса по user_id          -> Seq Scan по 1,2 млн строк
--   B) SUM(amount) по transactions с индексом (user_id, created_at DESC, id DESC) -> пользователь с самой длинной историей
--   C) SELECT balance FROM users WHERE id = ?                       -> одна строка по первичному ключу
-- Цена денормализации: запись в журнал обновляет users.balance триггером (см. тесты 02_ledger, 04_billing).
\set ON_ERROR_STOP on
\pset pager off
SET jit = off;
\echo '=== (в) Баланс: SUM по журналу против users.balance ==='
SELECT user_id AS uid FROM transactions GROUP BY user_id ORDER BY count(*) DESC LIMIT 1 \gset
SELECT count(*) AS ledger_rows_of_user, sum(amount) AS sum_of_ledger, (SELECT balance FROM users WHERE id = :uid) AS users_balance
FROM transactions WHERE user_id = :uid;

\echo
\echo '--- A) SUM по журналу, индекса по user_id нет'
BEGIN;
DROP INDEX idx_transactions_user_created;
\o /dev/null
SELECT sum(amount) FROM transactions WHERE user_id = :uid;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT sum(amount) FROM transactions WHERE user_id = :uid;
ROLLBACK;

\echo
\echo '--- B) SUM по журналу с индексом по user_id'
\o /dev/null
SELECT sum(amount) FROM transactions WHERE user_id = :uid;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT sum(amount) FROM transactions WHERE user_id = :uid;

\echo
\echo '--- C) users.balance (денормализация)'
\o /dev/null
SELECT balance FROM users WHERE id = :uid;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT balance FROM users WHERE id = :uid;

-- Бенчмарк (е): история операций пользователя с пагинацией (FR-13), страница из 50 строк в середине истории.
--   A) OFFSET без индекса                                   -> сортировка всей истории пользователя после Seq Scan журнала
--   B) OFFSET с индексом (user_id, created_at DESC, id DESC) -> индекс даёт порядок, но первые N строк приходится отбрасывать
--   C) keyset-пагинация с тем же индексом                    -> WHERE (created_at, id) < (последняя строка предыдущей страницы)
-- Keyset читает ровно 50 строк независимо от номера страницы, OFFSET — OFFSET + 50.
\set ON_ERROR_STOP on
\pset pager off
SET jit = off;
\echo '=== (е) История операций: OFFSET против keyset ==='
SELECT user_id AS uid, count(*) AS n FROM transactions GROUP BY user_id ORDER BY count(*) DESC LIMIT 1 \gset
SELECT :n / 2 AS off \gset
\echo user_id = :uid, записей в журнале = :n, смещение страницы = :off
-- последняя строка предыдущей страницы: от неё строится keyset-условие
SELECT created_at AS last_ts, id AS last_id FROM transactions WHERE user_id = :uid ORDER BY created_at DESC, id DESC OFFSET (:off - 1) LIMIT 1 \gset

\echo
\echo '--- A) OFFSET, индекса по user_id нет'
BEGIN;
DROP INDEX idx_transactions_user_created;
\o /dev/null
SELECT id, type, amount, created_at FROM transactions WHERE user_id = :uid ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET :off;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT id, type, amount, created_at FROM transactions WHERE user_id = :uid ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET :off;
ROLLBACK;

\echo
\echo '--- B) OFFSET с индексом'
\o /dev/null
SELECT id, type, amount, created_at FROM transactions WHERE user_id = :uid ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET :off;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT id, type, amount, created_at FROM transactions WHERE user_id = :uid ORDER BY created_at DESC, id DESC LIMIT 50 OFFSET :off;

\echo
\echo '--- C) keyset с индексом'
\o /dev/null
SELECT id, type, amount, created_at FROM transactions WHERE user_id = :uid AND (created_at, id) < (:'last_ts', :last_id) ORDER BY created_at DESC, id DESC LIMIT 50;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT id, type, amount, created_at FROM transactions WHERE user_id = :uid AND (created_at, id) < (:'last_ts', :last_id) ORDER BY created_at DESC, id DESC LIMIT 50;

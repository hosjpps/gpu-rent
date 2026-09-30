-- Бенчмарк (б): расходы пользователя за месяц из usage_records (FR-13, отчёт по периоду).
--   SELECT sum(amount) FROM usage_records WHERE user_id = ? AND period_start in [месяц)
-- Три состояния на 1,18 млн строк в 12 партициях, для «типичного» пользователя (медиана по числу записей в августе):
--   A) полный скан: индекса нет, а условие по месяцу записано как date_trunc(..) = .. (партиции отсечь нельзя) -> все партиции
--   B) partition pruning без индекса: условие по «сырому» period_start, читается одна партиция, но целиком (Seq Scan)
--   C) pruning + индекс (user_id, period_start): одна партиция и только строки пользователя
-- D) — тот же запрос для самого «тяжёлого» пользователя месяца: записей много, но индекс всё равно выигрывает у скана партиции.
\set ON_ERROR_STOP on
\pset pager off
SET jit = off;
\echo '=== (б) Расходы пользователя за месяц ==='
CREATE TEMP TABLE _aug AS
SELECT user_id, count(*) AS c FROM usage_records
WHERE period_start >= '2026-08-01+00' AND period_start < '2026-09-01+00' GROUP BY user_id;
SELECT user_id AS uid, c AS uid_rows FROM _aug
ORDER BY abs(c - (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY c) FROM _aug)), user_id LIMIT 1 \gset
SELECT user_id AS heavy_uid, c AS heavy_rows FROM _aug ORDER BY c DESC, user_id LIMIT 1 \gset
SELECT count(*) AS users_with_usage_in_august, max(c) AS max_rows, percentile_disc(0.5) WITHIN GROUP (ORDER BY c) AS median_rows FROM _aug;
\echo типичный пользователь: user_id = :uid (:uid_rows записей в августе); тяжёлый: user_id = :heavy_uid (:heavy_rows записей)
SELECT count(*) AS usage_rows_total FROM usage_records;

\echo
\echo '--- A) типичный пользователь: полный скан, нет индекса и нет отсечения партиций'
BEGIN;
DROP INDEX idx_usage_user_period;
\o /dev/null
SELECT sum(amount) FROM usage_records WHERE user_id = :uid AND date_trunc('month', period_start AT TIME ZONE 'UTC') = '2026-08-01';
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT sum(amount) FROM usage_records WHERE user_id = :uid AND date_trunc('month', period_start AT TIME ZONE 'UTC') = '2026-08-01';
ROLLBACK;

\echo
\echo '--- B) типичный пользователь: отсечение партиций, индекса нет'
BEGIN;
DROP INDEX idx_usage_user_period;
\o /dev/null
SELECT sum(amount) FROM usage_records WHERE user_id = :uid AND period_start >= '2026-08-01+00' AND period_start < '2026-09-01+00';
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT sum(amount) FROM usage_records WHERE user_id = :uid AND period_start >= '2026-08-01+00' AND period_start < '2026-09-01+00';
ROLLBACK;

\echo
\echo '--- C) типичный пользователь: отсечение партиций + индекс (user_id, period_start)'
\o /dev/null
SELECT sum(amount) FROM usage_records WHERE user_id = :uid AND period_start >= '2026-08-01+00' AND period_start < '2026-09-01+00';
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT sum(amount) FROM usage_records WHERE user_id = :uid AND period_start >= '2026-08-01+00' AND period_start < '2026-09-01+00';

\echo
\echo '--- D) самый тяжёлый пользователь: pruning + индекс'
\o /dev/null
SELECT sum(amount) FROM usage_records WHERE user_id = :heavy_uid AND period_start >= '2026-08-01+00' AND period_start < '2026-09-01+00';
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT sum(amount) FROM usage_records WHERE user_id = :heavy_uid AND period_start >= '2026-08-01+00' AND period_start < '2026-09-01+00';

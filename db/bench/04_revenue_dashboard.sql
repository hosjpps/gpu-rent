-- Бенчмарк (г): дашборд выручки администратора (FR-17): по ДЦ и моделям GPU.
--   A) агрегат по сырым usage_records (JOIN с instances и nodes) за месяц
--   B) то же по материализованному представлению mv_daily_revenue за месяц
--   C, D) то же самое за весь год
-- Выручка и GPU-часы в обоих вариантах совпадают (проверяется в тесте 12_seed_integrity).
\set ON_ERROR_STOP on
\pset pager off
SET jit = off;
\echo '=== (г) Дашборд выручки: сырые usage_records против mv_daily_revenue ==='
SELECT count(*) AS usage_rows, (SELECT count(*) FROM mv_daily_revenue) AS mv_rows FROM usage_records;

\echo
\echo '--- A) сырые данные, сентябрь 2026'
\o /dev/null
SELECT n.datacenter_id, i.gpu_model_id, sum(u.amount) AS revenue, round(sum(u.quantity * i.gpu_count) / 3600, 4) AS gpu_hours
FROM usage_records u JOIN instances i ON i.id = u.instance_id JOIN nodes n ON n.id = i.node_id
WHERE u.kind = 'gpu' AND u.period_start >= '2026-09-01 00:00:00+03' AND u.period_start < '2026-10-01 00:00:00+03' GROUP BY 1, 2;
\o
EXPLAIN (ANALYZE, BUFFERS)
SELECT n.datacenter_id, i.gpu_model_id, sum(u.amount) AS revenue, round(sum(u.quantity * i.gpu_count) / 3600, 4) AS gpu_hours
FROM usage_records u JOIN instances i ON i.id = u.instance_id JOIN nodes n ON n.id = i.node_id
WHERE u.kind = 'gpu' AND u.period_start >= '2026-09-01 00:00:00+03' AND u.period_start < '2026-10-01 00:00:00+03' GROUP BY 1, 2;

\echo
\echo '--- B) mv_daily_revenue, сентябрь 2026'
\o /dev/null
SELECT datacenter_id, gpu_model_id, sum(revenue), sum(gpu_hours) FROM mv_daily_revenue WHERE day >= '2026-09-01' AND day < '2026-10-01' GROUP BY 1, 2;
\o
EXPLAIN (ANALYZE, BUFFERS)
SELECT datacenter_id, gpu_model_id, sum(revenue), sum(gpu_hours) FROM mv_daily_revenue WHERE day >= '2026-09-01' AND day < '2026-10-01' GROUP BY 1, 2;

\echo
\echo '--- C) сырые данные, весь год'
\o /dev/null
SELECT n.datacenter_id, i.gpu_model_id, sum(u.amount) AS revenue, round(sum(u.quantity * i.gpu_count) / 3600, 4) AS gpu_hours
FROM usage_records u JOIN instances i ON i.id = u.instance_id JOIN nodes n ON n.id = i.node_id
WHERE u.kind = 'gpu' GROUP BY 1, 2;
\o
EXPLAIN (ANALYZE, BUFFERS)
SELECT n.datacenter_id, i.gpu_model_id, sum(u.amount) AS revenue, round(sum(u.quantity * i.gpu_count) / 3600, 4) AS gpu_hours
FROM usage_records u JOIN instances i ON i.id = u.instance_id JOIN nodes n ON n.id = i.node_id
WHERE u.kind = 'gpu' GROUP BY 1, 2;

\echo
\echo '--- D) mv_daily_revenue, весь год'
\o /dev/null
SELECT datacenter_id, gpu_model_id, sum(revenue), sum(gpu_hours) FROM mv_daily_revenue GROUP BY 1, 2;
\o
EXPLAIN (ANALYZE, BUFFERS)
SELECT datacenter_id, gpu_model_id, sum(revenue), sum(gpu_hours) FROM mv_daily_revenue GROUP BY 1, 2;

\echo
\echo '--- Обновление витрины: REFRESH MATERIALIZED VIEW CONCURRENTLY (цена актуальности)'
\timing on
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_revenue;
\timing off

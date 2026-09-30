-- Бенчмарк (д): каталог v_gpu_availability (FR-05): «сколько свободно и по какой цене» по всем ДЦ и моделям.
-- Узкое место — определение занятых GPU: поиск активных аллокаций (открытый верхний предел allocated_during) в instance_gpus.
--   A) без partial-индекса idx_instance_gpus_active (остаётся только gist от EXCLUDE и FK-индекс по instance_id)
--   B) с partial-индексом (gpu_id) WHERE upper_inf(allocated_during)
-- Кроме всего каталога меряется выборка одного ДЦ (так запрашивает UI).
\set ON_ERROR_STOP on
\pset pager off
SET jit = off;
\echo '=== (д) Каталог v_gpu_availability ==='
SELECT count(*) AS allocations_total, count(*) FILTER (WHERE upper_inf(allocated_during)) AS allocations_open FROM instance_gpus;
SELECT pg_size_pretty(pg_relation_size('idx_instance_gpus_active')) AS partial_index_size,
       pg_size_pretty(pg_relation_size('ex_instance_gpus_no_overlap')) AS gist_exclude_index_size;

\echo
\echo '--- A) без partial-индекса: весь каталог'
BEGIN;
DROP INDEX idx_instance_gpus_active;
\o /dev/null
SELECT * FROM v_gpu_availability;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_gpu_availability;
ROLLBACK;

\echo
\echo '--- B) с partial-индексом: весь каталог'
\o /dev/null
SELECT * FROM v_gpu_availability;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_gpu_availability;

\echo
\echo '--- C) без partial-индекса: один ДЦ (MSK-1)'
BEGIN;
DROP INDEX idx_instance_gpus_active;
\o /dev/null
SELECT * FROM v_gpu_availability WHERE datacenter_code = 'MSK-1';
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_gpu_availability WHERE datacenter_code = 'MSK-1';
ROLLBACK;

\echo
\echo '--- D) с partial-индексом: один ДЦ (MSK-1)'
\o /dev/null
SELECT * FROM v_gpu_availability WHERE datacenter_code = 'MSK-1';
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM v_gpu_availability WHERE datacenter_code = 'MSK-1';

-- Размеры таблиц и индексов после сида (pg_total_relation_size = таблица + индексы + TOAST).
-- У партиционированной usage_records собственное хранилище отсутствует, поэтому размер считается по листьям
-- pg_partition_tree. Точные числа строк берутся через count(*).
\set ON_ERROR_STOP on
\pset pager off
\echo '=== Размеры объектов схемы gpu_rent ==='
\echo Время последнего сида, с: :seed_seconds
SELECT current_setting('server_version') AS postgres_version, pg_size_pretty(pg_database_size(current_database())) AS database_size;

\echo
\echo '--- Таблицы и материализованные представления (без партиций)'
SELECT c.relname AS object,
       CASE c.relkind WHEN 'p' THEN 'partitioned table' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
       (xpath('/row/cnt/text()', query_to_xml(format('SELECT count(*) AS cnt FROM gpu_rent.%I', c.relname), false, true, '')))[1]::text::bigint AS rows,
       pg_size_pretty(CASE WHEN c.relkind = 'p'
                           THEN (SELECT sum(pg_relation_size(t.relid)) FROM pg_partition_tree(c.oid) t WHERE t.isleaf)
                           ELSE pg_table_size(c.oid) END) AS data,
       pg_size_pretty(CASE WHEN c.relkind = 'p'
                           THEN (SELECT sum(pg_indexes_size(t.relid)) FROM pg_partition_tree(c.oid) t WHERE t.isleaf)
                           ELSE pg_indexes_size(c.oid) END) AS indexes,
       pg_size_pretty(CASE WHEN c.relkind = 'p'
                           THEN (SELECT sum(pg_total_relation_size(t.relid)) FROM pg_partition_tree(c.oid) t WHERE t.isleaf)
                           ELSE pg_total_relation_size(c.oid) END) AS total_size
FROM pg_class c
WHERE c.relnamespace = 'gpu_rent'::regnamespace AND c.relkind IN ('r', 'p', 'm') AND NOT c.relispartition
ORDER BY CASE WHEN c.relkind = 'p'
              THEN (SELECT sum(pg_total_relation_size(t.relid)) FROM pg_partition_tree(c.oid) t WHERE t.isleaf)
              ELSE pg_total_relation_size(c.oid) END DESC;

\echo
\echo '--- Партиции usage_records'
SELECT c.relname AS partition,
       (xpath('/row/cnt/text()', query_to_xml(format('SELECT count(*) AS cnt FROM gpu_rent.%I', c.relname), false, true, '')))[1]::text::bigint AS rows,
       pg_size_pretty(pg_relation_size(c.oid)) AS data,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = 'gpu_rent.usage_records'::regclass
ORDER BY c.relname;

\echo
\echo '--- Крупнейшие индексы'
SELECT c.relname AS index_name, t.relname AS table_name, pg_size_pretty(pg_relation_size(c.oid)) AS size,
       pg_get_indexdef(c.oid) AS definition
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
JOIN pg_class t ON t.oid = i.indrelid
WHERE c.relnamespace = 'gpu_rent'::regnamespace AND c.relkind IN ('i', 'I') AND NOT c.relispartition
  AND pg_relation_size(c.oid) > 0
ORDER BY pg_relation_size(c.oid) DESC
LIMIT 12;

\echo
\echo '--- BRIN против btree на одной и той же колонке period_start (партиция 2026_08)'
SELECT pg_size_pretty(pg_relation_size('usage_records_2026_08_period_start_idx'))        AS brin_period_start,
       pg_size_pretty(pg_relation_size('usage_records_2026_08_user_id_period_start_idx')) AS btree_user_period;

-- Бенчмарк (а): «мои активные инстансы» — личный кабинет, самый частый запрос приложения.
--   SELECT ... FROM instances WHERE user_id = ? AND status <> 'terminated' ORDER BY created_at DESC
-- Сравниваем три состояния индексов на одной и той же БД (DROP INDEX внутри BEGIN .. ROLLBACK, данные не меняются):
--   A) нет индексов по user_id          -> Seq Scan по всем 20 000 инстансов
--   B) только полный FK-индекс          -> Index Scan по ВСЕМ инстансам пользователя (в т.ч. терминированным) + фильтр
--   C) есть partial-индекс (user_id) WHERE status <> 'terminated' -> читаются только живые инстансы
-- На таблице в 20 000 строк абсолютное время B и C измеряется сотыми долями миллисекунды и зависит от прогрева кэша;
-- устойчивое различие — число прочитанных страниц (Buffers) и размер индекса (первый SELECT ниже): терминированные
-- инстансы, которых большинство, в partial-индекс не попадают.
-- Выполняется суперпользователем (RLS не участвует), jit отключён для сопоставимости времени.
\set ON_ERROR_STOP on
\pset pager off
SET jit = off;
\echo '=== (а) Список активных инстансов пользователя ==='
-- берём пользователя с наибольшим числом инстансов: худший случай для варианта B
SELECT user_id AS uid FROM instances GROUP BY user_id ORDER BY count(*) DESC LIMIT 1 \gset
SELECT count(*) AS all_instances, count(*) FILTER (WHERE status <> 'terminated') AS active_instances
FROM instances WHERE user_id = :uid;
SELECT pg_size_pretty(pg_relation_size('idx_instances_user'))        AS full_fk_index_size,
       pg_size_pretty(pg_relation_size('idx_instances_user_active')) AS partial_index_size;

\echo
\echo '--- A) без индексов по user_id'
BEGIN;
DROP INDEX idx_instances_user_active;
DROP INDEX idx_instances_user;
\o /dev/null
SELECT id, name, status FROM instances WHERE user_id = :uid AND status <> 'terminated' ORDER BY created_at DESC;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT id, name, status FROM instances WHERE user_id = :uid AND status <> 'terminated' ORDER BY created_at DESC;
ROLLBACK;

\echo
\echo '--- B) только полный индекс по user_id (FK-индекс)'
BEGIN;
DROP INDEX idx_instances_user_active;
\o /dev/null
SELECT id, name, status FROM instances WHERE user_id = :uid AND status <> 'terminated' ORDER BY created_at DESC;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT id, name, status FROM instances WHERE user_id = :uid AND status <> 'terminated' ORDER BY created_at DESC;
ROLLBACK;

\echo
\echo '--- C) с partial-индексом WHERE status <> ''terminated'''
\o /dev/null
SELECT id, name, status FROM instances WHERE user_id = :uid AND status <> 'terminated' ORDER BY created_at DESC;
\o
EXPLAIN (ANALYZE, BUFFERS) SELECT id, name, status FROM instances WHERE user_id = :uid AND status <> 'terminated' ORDER BY created_at DESC;

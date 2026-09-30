-- 0009: представления для каталога (FR-05), дашборда (FR-17) и аналитики без ПДн (NFR-09).
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

-- Каталог: ДЦ x модель. «Свободные» — включённые GPU online-нод без активной аллокации.
-- Активная аллокация = открытый верхний предел allocated_during; для неё есть partial-индекс.
-- Цены агрегируются отдельно и присоединяются к уже свёрнутым счётчикам, иначе две строки цены
-- (on_demand и spot) удвоили бы число GPU.
CREATE VIEW v_gpu_availability AS
WITH gpu_state AS (
    SELECT n.datacenter_id, g.gpu_model_id, g.is_enabled,
           (n.status = 'online') AS node_online,
           (ig.id IS NOT NULL)   AS is_busy
    FROM gpus g
    JOIN nodes n ON n.id = g.node_id
    LEFT JOIN instance_gpus ig ON ig.gpu_id = g.id AND upper_inf(ig.allocated_during)
), counts AS (
    SELECT datacenter_id, gpu_model_id,
           count(*)                                                        AS total_gpus,
           count(*) FILTER (WHERE is_enabled)                              AS enabled_gpus,
           count(*) FILTER (WHERE is_busy)                                 AS busy_gpus,
           count(*) FILTER (WHERE is_enabled AND node_online AND NOT is_busy) AS free_gpus
    FROM gpu_state
    GROUP BY datacenter_id, gpu_model_id
), prices AS (
    SELECT datacenter_id, gpu_model_id,
           max(price_per_hour) FILTER (WHERE pricing_type = 'on_demand') AS price_on_demand,
           max(price_per_hour) FILTER (WHERE pricing_type = 'spot')      AS price_spot
    FROM gpu_prices
    WHERE valid_during @> now()
    GROUP BY datacenter_id, gpu_model_id
)
SELECT d.id   AS datacenter_id,
       d.code AS datacenter_code,
       m.id   AS gpu_model_id,
       m.name AS gpu_model,
       m.vram_gb,
       c.total_gpus, c.enabled_gpus, c.busy_gpus, c.free_gpus,
       p.price_on_demand, p.price_spot
FROM counts c
JOIN datacenters d ON d.id = c.datacenter_id AND d.is_active
JOIN gpu_models  m ON m.id = c.gpu_model_id
LEFT JOIN prices p ON p.datacenter_id = c.datacenter_id AND p.gpu_model_id = c.gpu_model_id;

-- Выручка по дням (часовой пояс Москвы), ДЦ и модели. ДЦ и модель берём из instances (модель хранится в
-- самом инстансе, ДЦ — через ноду), а не из instance_gpus: JOIN с аллокациями размножил бы суммы
-- в gpu_count раз. GPU-часы = секунды работы * число GPU / 3600.
-- День определяется по началу интервала: минутный интервал через полночь целиком относится к предыдущему дню.
CREATE MATERIALIZED VIEW mv_daily_revenue AS
SELECT (u.period_start AT TIME ZONE 'Europe/Moscow')::date AS day,
       n.datacenter_id,
       i.gpu_model_id,
       sum(u.amount)                               AS revenue,
       round(sum(u.quantity * i.gpu_count) / 3600, 4) AS gpu_hours,
       count(*)                                    AS usage_rows
FROM usage_records u
JOIN instances i ON i.id = u.instance_id
JOIN nodes n     ON n.id = i.node_id
WHERE u.kind = 'gpu'
GROUP BY 1, 2, 3
WITH DATA;

-- Уникальный индекс обязателен для REFRESH MATERIALIZED VIEW CONCURRENTLY (читатели не блокируются).
CREATE UNIQUE INDEX uq_mv_daily_revenue ON mv_daily_revenue (day, datacenter_id, gpu_model_id);

-- Обновление витрины планировщиком: владелец MV — gpu_rent_owner, приложению REFRESH напрямую недоступен.
CREATE FUNCTION fn_refresh_daily_revenue() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    PERFORM _fn_assert_system();
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_revenue;
END
$$;

-- Маскирование по 152-ФЗ: аналитику нужны сегменты и динамика, а не личность.
-- Email: два первых символа и домен; ФИО: только инициалы.
CREATE VIEW v_users_masked AS
SELECT u.id,
       regexp_replace(u.email::text, '^(.{1,2}).*(@.*)$', '\1***\2') AS email_masked,
       regexp_replace(u.full_name, '(\S)\S*', '\1.', 'g')            AS full_name_masked,
       u.role,
       u.status,
       u.balance,
       (u.email_verified_at IS NOT NULL) AS email_verified,
       u.created_at
FROM users u;

COMMENT ON VIEW v_gpu_availability IS 'Каталог FR-05: GPU по ДЦ и моделям — всего/включено/занято/свободно и текущие цены on_demand/spot.';
COMMENT ON COLUMN v_gpu_availability.free_gpus IS 'Включённые GPU online-нод без активной аллокации.';
COMMENT ON MATERIALIZED VIEW mv_daily_revenue IS 'Дашборд FR-17: выручка и GPU-часы по дням (МСК), ДЦ и модели. Обновляется fn_refresh_daily_revenue().';
COMMENT ON VIEW v_users_masked IS 'Пользователи без ПДн (NFR-09): маскированные email и ФИО. Единственный доступ роли gpu_rent_analyst к данным о людях.';
COMMENT ON FUNCTION fn_refresh_daily_revenue() IS 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_revenue; только для системного/административного контекста.';

INSERT INTO schema_migrations (version) VALUES ('0009_views');
COMMIT;

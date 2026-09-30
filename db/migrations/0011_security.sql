-- 0011: права ролей и политики RLS (NFR-03, NFR-09).
--
--   gpu_rent_owner   — владелец схемы, выполняет миграции и SECURITY DEFINER-функции (RLS его не касается);
--   gpu_rent_app     — приложение: DML только по нужным таблицам/столбцам, без DDL, журналы только на чтение;
--   gpu_rent_analyst — только три объекта: v_users_masked, mv_daily_revenue, v_gpu_availability.
--
-- Граница доверия RLS: политики защищают от забытого фильтра в запросе приложения, но не от
-- компрометации самой роли gpu_rent_app — её владелец может выставить любой app.user_id.
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

REVOKE ALL ON ALL TABLES    IN SCHEMA gpu_rent FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA gpu_rent FROM PUBLIC;

-- Свои функции закрываем явно (п. 8.9), даже если ALTER DEFAULT PRIVILEGES уже сделал это при создании;
-- функции расширений (pgcrypto, citext) остаются публичными — это библиотечные примитивы.
DO $$
DECLARE
    f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        WHERE p.pronamespace = 'gpu_rent'::regnamespace
          AND p.proowner = 'gpu_rent_owner'::regrole
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f.sig);
    END LOOP;
END
$$;

GRANT USAGE ON SCHEMA gpu_rent TO gpu_rent_app, gpu_rent_analyst;

-- ---------------------------------------------------------------------------------------------
-- gpu_rent_app: таблицы
-- ---------------------------------------------------------------------------------------------
-- Баланс не входит ни в INSERT, ни в UPDATE: его меняет только триггер журнала.
GRANT SELECT ON users TO gpu_rent_app;
GRANT INSERT (email, password_hash, full_name) ON users TO gpu_rent_app;
GRANT UPDATE (email, password_hash, full_name, role, status, email_verified_at) ON users TO gpu_rent_app;

GRANT SELECT, INSERT ON api_keys TO gpu_rent_app;
GRANT UPDATE (name, last_used_at, revoked_at) ON api_keys TO gpu_rent_app;
GRANT SELECT, INSERT, DELETE ON ssh_keys TO gpu_rent_app;
GRANT UPDATE (name) ON ssh_keys TO gpu_rent_app;

-- Справочники инфраструктуры и цены: админ-панель (FR-14, FR-15). DELETE не выдаём: история важнее.
GRANT SELECT, INSERT, UPDATE ON datacenters, gpu_models, nodes, gpus, gpu_prices, storage_prices TO gpu_rent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON templates TO gpu_rent_app;

GRANT SELECT ON volumes TO gpu_rent_app;
GRANT INSERT (user_id, datacenter_id, name, size_gb) ON volumes TO gpu_rent_app;
GRANT UPDATE (name, size_gb, status, deleted_at) ON volumes TO gpu_rent_app;

-- Инстансы создаются и меняют состояние только функциями жизненного цикла.
GRANT SELECT ON instances TO gpu_rent_app;
GRANT UPDATE (name) ON instances TO gpu_rent_app;
GRANT SELECT ON instance_gpus TO gpu_rent_app;
GRANT SELECT, DELETE ON instance_env_vars TO gpu_rent_app;   -- запись — через fn_env_set

-- Журналы: UPDATE/DELETE/TRUNCATE не выдаются никогда (п. 8.8); запись в transactions и usage_records — только через функции.
GRANT SELECT ON transactions, usage_records TO gpu_rent_app;
REVOKE UPDATE, DELETE, TRUNCATE ON transactions, audit_log, usage_records FROM gpu_rent_app;   -- явно, хотя не выдавались
GRANT SELECT, INSERT ON audit_log TO gpu_rent_app;

GRANT SELECT ON payments TO gpu_rent_app;
GRANT INSERT (user_id, provider, provider_payment_id, amount) ON payments TO gpu_rent_app;
GRANT UPDATE (status, paid_at) ON payments TO gpu_rent_app;

GRANT SELECT ON v_gpu_availability, mv_daily_revenue TO gpu_rent_app;

-- ---------------------------------------------------------------------------------------------
-- gpu_rent_analyst: только маскированные/агрегированные объекты
-- ---------------------------------------------------------------------------------------------
GRANT SELECT ON v_users_masked, mv_daily_revenue, v_gpu_availability TO gpu_rent_analyst;

-- ---------------------------------------------------------------------------------------------
-- Функции: EXECUTE только приложению. Внутренние (_fn_*) и триггерные не выдаются никому.
-- ---------------------------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
    fn_app_user_id(), fn_app_is_admin(),
    fn_start_instance(bigint, bigint, bigint, integer, pricing_type, bigint, text, integer, bigint),
    fn_resume_instance(uuid), fn_stop_instance(uuid), fn_terminate_instance(uuid),
    fn_bill_usage(timestamptz, bigint), fn_topup(bigint),
    fn_ensure_usage_partition(date), fn_refresh_daily_revenue(),
    fn_env_set(uuid, text, text), fn_env_get(uuid, text)
TO gpu_rent_app;

-- ---------------------------------------------------------------------------------------------
-- RLS (FR-16, NFR-03): строки своего пользователя либо всё для администратора.
-- Без app.user_id политика даёт пустой результат, а не ошибку (п. 8.9).
-- Владелец таблиц (gpu_rent_owner) политики обходит — так работают SECURITY DEFINER-функции.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE instances          ENABLE ROW LEVEL SECURITY;
ALTER TABLE volumes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ssh_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records      ENABLE ROW LEVEL SECURITY;
ALTER TABLE instance_env_vars  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_instances ON instances FOR ALL TO gpu_rent_app
    USING (user_id = fn_app_user_id() OR fn_app_is_admin())
    WITH CHECK (user_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_volumes ON volumes FOR ALL TO gpu_rent_app
    USING (user_id = fn_app_user_id() OR fn_app_is_admin())
    WITH CHECK (user_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_ssh_keys ON ssh_keys FOR ALL TO gpu_rent_app
    USING (user_id = fn_app_user_id() OR fn_app_is_admin())
    WITH CHECK (user_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_api_keys ON api_keys FOR ALL TO gpu_rent_app
    USING (user_id = fn_app_user_id() OR fn_app_is_admin())
    WITH CHECK (user_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_payments ON payments FOR ALL TO gpu_rent_app
    USING (user_id = fn_app_user_id() OR fn_app_is_admin())
    WITH CHECK (user_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_transactions ON transactions FOR SELECT TO gpu_rent_app
    USING (user_id = fn_app_user_id() OR fn_app_is_admin());
CREATE POLICY p_usage_records ON usage_records FOR SELECT TO gpu_rent_app
    USING (user_id = fn_app_user_id() OR fn_app_is_admin());

-- Секреты видны ровно тем, кто видит сам инстанс (подзапрос уже отфильтрован политикой p_instances).
CREATE POLICY p_instance_env_vars ON instance_env_vars FOR ALL TO gpu_rent_app
    USING (EXISTS (SELECT 1 FROM instances i WHERE i.id = instance_env_vars.instance_id));

-- Аудит: писать может приложение, читать — только администратор.
CREATE POLICY p_audit_log_read   ON audit_log FOR SELECT TO gpu_rent_app USING (fn_app_is_admin());
CREATE POLICY p_audit_log_insert ON audit_log FOR INSERT TO gpu_rent_app WITH CHECK (true);

INSERT INTO schema_migrations (version) VALUES ('0011_security');
COMMIT;

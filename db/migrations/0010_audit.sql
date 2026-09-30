-- 0010: аудит (FR-18): изменения роли/статуса пользователя, цен GPU и статуса инстанса -> audit_log.
-- Функции SECURITY DEFINER: писать в audit_log должен любой инициатор изменения, даже если у его роли
-- нет права INSERT в журнал. Кто действовал, берётся из контекста приложения (app.user_id, app.client_ip).
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

CREATE FUNCTION _fn_audit_ip() RETURNS inet
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.client_ip', true), '')::inet $$;

CREATE FUNCTION fn_audit_users() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip)
        VALUES (fn_app_user_id(), 'user.role_changed', 'users', NEW.id::text,
                jsonb_build_object('from', OLD.role, 'to', NEW.role), _fn_audit_ip());
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip)
        VALUES (fn_app_user_id(), 'user.status_changed', 'users', NEW.id::text,
                jsonb_build_object('from', OLD.status, 'to', NEW.status), _fn_audit_ip());
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_audit_users AFTER UPDATE OF role, status ON users
    FOR EACH ROW EXECUTE FUNCTION fn_audit_users();

CREATE FUNCTION fn_audit_gpu_prices() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_row gpu_prices := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
    INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip)
    VALUES (fn_app_user_id(), 'gpu_price.' || lower(TG_OP), 'gpu_prices', v_row.id::text,
            CASE TG_OP
                WHEN 'INSERT' THEN jsonb_build_object('new', to_jsonb(NEW))
                WHEN 'UPDATE' THEN jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))
                ELSE               jsonb_build_object('old', to_jsonb(OLD))
            END,
            _fn_audit_ip());
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_audit_gpu_prices AFTER INSERT OR UPDATE OR DELETE ON gpu_prices
    FOR EACH ROW EXECUTE FUNCTION fn_audit_gpu_prices();

CREATE FUNCTION fn_audit_instances() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip)
    VALUES (fn_app_user_id(), 'instance.status_changed', 'instances', NEW.id::text,
            jsonb_build_object('user_id', NEW.user_id, 'from', OLD.status, 'to', NEW.status), _fn_audit_ip());
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_audit_instances AFTER UPDATE OF status ON instances
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION fn_audit_instances();

INSERT INTO schema_migrations (version) VALUES ('0010_audit');
COMMIT;

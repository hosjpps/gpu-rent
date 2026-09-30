-- 0005: триггеры целостности: журнал только на добавление, баланс, неизменяемые поля,
-- автомат статусов инстанса, согласованность тома/ноды/GPU.
-- Все функции с фиксированным search_path: иначе вызывающий мог бы подменить объекты своей схемой.
-- SECURITY DEFINER только там, где триггер читает/пишет таблицы, недоступные роли приложения.
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

-- ---------------------------------------------------------------------------------------------
-- Append-only. Защита в два слоя: REVOKE в 0011 и этот триггер (владельца он тоже
-- останавливает, а REVOKE владельца не ограничивает).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_forbid_modification() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER trg_transactions_append_only BEFORE UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_modification();
CREATE TRIGGER trg_transactions_no_truncate BEFORE TRUNCATE ON transactions
    FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_modification();

CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_modification();
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_modification();

-- Строчный триггер на партиционированной таблице клонируется в каждую партицию автоматически.
-- Триггер TRUNCATE уровня оператора не клонируется — его добавляет fn_ensure_usage_partition (0006).
CREATE TRIGGER trg_usage_records_append_only BEFORE UPDATE OR DELETE ON usage_records
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_modification();
CREATE TRIGGER trg_usage_records_no_truncate BEFORE TRUNCATE ON usage_records
    FOR EACH STATEMENT EXECUTE FUNCTION fn_forbid_modification();

-- ---------------------------------------------------------------------------------------------
-- Баланс: users.balance меняется только инкрементом из триггера журнала.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_ledger_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    -- Инкремент, а не пересчёт SUM(): O(1) на запись и нет гонки «прочитал сумму — записал».
    UPDATE users SET balance = balance + NEW.amount WHERE id = NEW.user_id;
    RETURN NULL;
END
$$;

CREATE TRIGGER trg_transactions_ledger AFTER INSERT ON transactions
    FOR EACH ROW EXECUTE FUNCTION fn_ledger_apply();

CREATE FUNCTION fn_users_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.balance <> 0 THEN
            RAISE EXCEPTION 'initial balance must be 0, credit it through transactions'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.balance IS DISTINCT FROM OLD.balance THEN
        -- Глубина 1 — UPDATE users выполнен напрямую; глубина 2 — из триггера fn_ledger_apply.
        IF pg_trigger_depth() < 2 THEN
            RAISE EXCEPTION 'users.balance can be changed only through transactions'
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSE
        -- updated_at отражает правки профиля, а не каждое списание
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_users_guard BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_users_guard();

-- ---------------------------------------------------------------------------------------------
-- Неизменяемые поля: имена колонок передаются аргументами триггера.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_forbid_column_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_col text;
BEGIN
    FOREACH v_col IN ARRAY TG_ARGV LOOP
        IF to_jsonb(NEW) -> v_col IS DISTINCT FROM to_jsonb(OLD) -> v_col THEN
            RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, v_col
                USING ERRCODE = 'restrict_violation';
        END IF;
    END LOOP;
    RETURN NEW;
END
$$;

-- Ноду нельзя «перенести» в другой ДЦ: на этом инварианте держится проверка «том и нода в одном ДЦ».
CREATE TRIGGER trg_nodes_immutable BEFORE UPDATE OF datacenter_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_column_change('datacenter_id');
CREATE TRIGGER trg_volumes_immutable BEFORE UPDATE OF user_id, datacenter_id ON volumes
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_column_change('user_id', 'datacenter_id');
-- Платёж после создания не меняет ни сумму, ни владельца: иначе журнал разойдётся с платежами.
CREATE TRIGGER trg_payments_immutable
    BEFORE UPDATE OF user_id, provider, provider_payment_id, amount ON payments
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_column_change('user_id', 'provider', 'provider_payment_id', 'amount');
-- Владелец, модель, число GPU и тариф определяют снимок цены — менять их у существующего инстанса нельзя.
CREATE TRIGGER trg_instances_immutable
    BEFORE UPDATE OF user_id, gpu_model_id, gpu_count, pricing_type ON instances
    FOR EACH ROW EXECUTE FUNCTION fn_forbid_column_change('user_id', 'gpu_model_id', 'gpu_count', 'pricing_type');

-- ---------------------------------------------------------------------------------------------
-- Автомат статусов инстанса (FR-08): terminated необратим.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_instances_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;
    IF (OLD.status, NEW.status) NOT IN (
        ('pending', 'running'),  ('pending', 'failed'),  ('pending', 'terminated'),
        ('running', 'stopped'),  ('running', 'failed'),  ('running', 'terminated'),
        ('stopped', 'running'),  ('stopped', 'terminated'),
        ('failed',  'terminated')
    ) THEN
        RAISE EXCEPTION 'instance status transition % -> % is not allowed', OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_instances_status_guard BEFORE UPDATE OF status ON instances
    FOR EACH ROW EXECUTE FUNCTION fn_instances_status_guard();

-- Том и нода инстанса — в одном ДЦ (FR-09). Проверяем при записи инстанса; ДЦ тома и ноды неизменяемы.
CREATE FUNCTION fn_instances_volume_dc() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF NEW.volume_id IS NOT NULL
       AND (SELECT v.datacenter_id FROM volumes v WHERE v.id = NEW.volume_id)
           IS DISTINCT FROM (SELECT n.datacenter_id FROM nodes n WHERE n.id = NEW.node_id)
    THEN
        RAISE EXCEPTION 'volume % and node % are in different datacenters', NEW.volume_id, NEW.node_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_instances_volume_dc BEFORE INSERT OR UPDATE OF volume_id, node_id ON instances
    FOR EACH ROW EXECUTE FUNCTION fn_instances_volume_dc();

-- GPU из аллокации обязана стоять в ноде инстанса и иметь модель инстанса.
CREATE FUNCTION fn_instance_gpus_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM instances i
        JOIN gpus g ON g.node_id = i.node_id AND g.gpu_model_id = i.gpu_model_id
        WHERE i.id = NEW.instance_id AND g.id = NEW.gpu_id
    ) THEN
        RAISE EXCEPTION 'gpu % does not belong to the node/model of instance %', NEW.gpu_id, NEW.instance_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_instance_gpus_consistency BEFORE INSERT ON instance_gpus
    FOR EACH ROW EXECUTE FUNCTION fn_instance_gpus_consistency();

-- ---------------------------------------------------------------------------------------------
-- Тома: нельзя удалить подключённый том, нельзя «воскресить» удалённый, размер только растёт (FR-09).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION fn_volumes_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
        RAISE EXCEPTION 'deleted volume % cannot be restored', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status = 'deleted' AND OLD.status <> 'deleted' AND EXISTS (
        SELECT 1 FROM instances i
        WHERE i.volume_id = NEW.id AND i.status IN ('pending', 'running', 'stopped')
    ) THEN
        RAISE EXCEPTION 'volume % is attached to a live instance', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.size_gb < OLD.size_gb THEN
        RAISE EXCEPTION 'volume size can only grow' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_volumes_guard BEFORE UPDATE OF status, size_gb ON volumes
    FOR EACH ROW EXECUTE FUNCTION fn_volumes_guard();

-- Платёж: pending -> succeeded|failed, succeeded -> refunded; остальное — ошибка.
CREATE FUNCTION fn_payments_status_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
BEGIN
    IF OLD.status <> NEW.status AND (OLD.status, NEW.status) NOT IN (
        ('pending', 'succeeded'), ('pending', 'failed'), ('succeeded', 'refunded')
    ) THEN
        RAISE EXCEPTION 'payment status transition % -> % is not allowed', OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_payments_status_guard BEFORE UPDATE OF status ON payments
    FOR EACH ROW EXECUTE FUNCTION fn_payments_status_guard();

INSERT INTO schema_migrations (version) VALUES ('0005_guards_and_triggers');
COMMIT;

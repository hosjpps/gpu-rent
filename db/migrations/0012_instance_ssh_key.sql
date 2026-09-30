-- 0012: SSH-ключ инстанса (FR-07): instances.ssh_key_id, составной FK на ssh_keys(id, user_id) и
-- параметр p_ssh_key_id в fn_start_instance.
--
-- Составной FK не даёт привязать чужой ключ, а ON DELETE SET NULL (ssh_key_id) при удалении ключа
-- обнуляет только ссылку: user_id остаётся (он NOT NULL), инстанс живёт дальше. Сам ключ агенту
-- ноды передаётся в команде запуска; в БД хранится только ссылка.
-- Сигнатура fn_start_instance меняется (новый последний параметр с DEFAULT NULL), поэтому старая
-- версия удаляется, а права и комментарий восстанавливаются как в 0008/0011.
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

ALTER TABLE ssh_keys ADD CONSTRAINT uq_ssh_keys_id_user UNIQUE (id, user_id);

ALTER TABLE instances ADD COLUMN ssh_key_id bigint;
ALTER TABLE instances ADD CONSTRAINT fk_instances_ssh_key_owner
    FOREIGN KEY (ssh_key_id, user_id) REFERENCES ssh_keys (id, user_id) ON DELETE SET NULL (ssh_key_id);
CREATE INDEX idx_instances_ssh_key ON instances (ssh_key_id) WHERE ssh_key_id IS NOT NULL;

COMMENT ON COLUMN instances.ssh_key_id IS
    'SSH-ключ, выбранный при запуске (FR-07). NULL — ключ не выбран или удалён позже; ключ того же пользователя (составной FK).';

DROP FUNCTION fn_start_instance(bigint, bigint, bigint, integer, pricing_type, bigint, text, integer, bigint);

CREATE FUNCTION fn_start_instance(
    p_user_id           bigint,
    p_datacenter_id     bigint,
    p_gpu_model_id      bigint,
    p_gpu_count         integer,
    p_pricing_type      pricing_type,
    p_template_id       bigint,
    p_name              text,
    p_container_disk_gb integer DEFAULT NULL,
    p_volume_id         bigint  DEFAULT NULL,
    p_ssh_key_id        bigint  DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gpu_rent, pg_temp AS $$
DECLARE
    v_user_status  user_status;
    v_now          timestamptz;
    v_default_disk integer;
    v_volume_dc    bigint;
    v_total        numeric;
    v_node         bigint;
    v_gpu_ids      bigint[];
    v_id           uuid;
BEGIN
    PERFORM _fn_assert_actor(p_user_id);
    IF p_gpu_count NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION 'gpu_count must be between 1 and 8' USING ERRCODE = 'GR005';
    END IF;

    SELECT u.status INTO v_user_status FROM users u WHERE u.id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user % not found', p_user_id USING ERRCODE = 'GR004';
    END IF;
    IF v_user_status <> 'active' THEN
        RAISE EXCEPTION 'user % is blocked', p_user_id USING ERRCODE = 'GR003';
    END IF;

    v_now := clock_timestamp();

    IF NOT EXISTS (SELECT 1 FROM datacenters d WHERE d.id = p_datacenter_id AND d.is_active) THEN
        RAISE EXCEPTION 'datacenter % not found or inactive', p_datacenter_id USING ERRCODE = 'GR004';
    END IF;

    SELECT t.default_disk_gb INTO v_default_disk
    FROM templates t
    WHERE t.id = p_template_id AND (t.is_public OR t.owner_id = p_user_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'template % not found', p_template_id USING ERRCODE = 'GR004';
    END IF;

    IF p_volume_id IS NOT NULL THEN
        SELECT v.datacenter_id INTO v_volume_dc
        FROM volumes v
        WHERE v.id = p_volume_id AND v.user_id = p_user_id AND v.status = 'active'
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'volume % not found', p_volume_id USING ERRCODE = 'GR004';
        END IF;
        IF v_volume_dc <> p_datacenter_id THEN
            RAISE EXCEPTION 'volume % is in another datacenter', p_volume_id USING ERRCODE = 'GR005';
        END IF;
        IF EXISTS (SELECT 1 FROM instances i
                   WHERE i.volume_id = p_volume_id AND i.status IN ('pending', 'running', 'stopped')) THEN
            RAISE EXCEPTION 'volume % is already attached to a live instance', p_volume_id USING ERRCODE = 'GR003';
        END IF;
    END IF;

    v_total := _fn_quote_instance(p_user_id, p_datacenter_id, p_gpu_model_id, p_gpu_count, p_pricing_type, v_now);

    SELECT a.o_node_id, a.o_gpu_ids INTO v_node, v_gpu_ids
    FROM _fn_alloc_gpus(p_datacenter_id, p_gpu_model_id, p_gpu_count) a;

    INSERT INTO instances (user_id, node_id, gpu_model_id, template_id, volume_id, ssh_key_id, name, pricing_type,
                           gpu_count, container_disk_gb, price_per_hour_snapshot, status,
                           created_at, started_at, last_billed_at)
    VALUES (p_user_id, v_node, p_gpu_model_id, p_template_id, p_volume_id, p_ssh_key_id, p_name, p_pricing_type,
            p_gpu_count, coalesce(p_container_disk_gb, v_default_disk), v_total, 'running',
            v_now, v_now, v_now)
    RETURNING id INTO v_id;

    INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during)
    SELECT v_id, g, tstzrange(v_now, NULL, '[)') FROM unnest(v_gpu_ids) AS g;

    RETURN v_id;
END
$$;

COMMENT ON FUNCTION fn_start_instance(bigint, bigint, bigint, integer, pricing_type, bigint, text, integer, bigint, bigint) IS
    'FR-07: проверки, снимок цены, подбор gpu_count GPU одной online-ноды (FOR UPDATE SKIP LOCKED), аллокация; необязательные том и SSH-ключ пользователя. Возвращает id инстанса.';

REVOKE EXECUTE ON FUNCTION fn_start_instance(bigint, bigint, bigint, integer, pricing_type, bigint, text, integer, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_start_instance(bigint, bigint, bigint, integer, pricing_type, bigint, text, integer, bigint, bigint) TO gpu_rent_app;

INSERT INTO schema_migrations (version) VALUES ('0012_instance_ssh_key');
COMMIT;

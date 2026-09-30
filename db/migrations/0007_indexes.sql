-- 0007: индексы. Обоснование каждого — замерами EXPLAIN (ANALYZE, BUFFERS) в db/bench.
-- Индексы, которые уже создают UNIQUE/PK/EXCLUDE, повторно не объявляются.
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

-- FK-индексы (там, где их не заменяет UNIQUE/EXCLUDE с тем же ведущим столбцом)
CREATE INDEX idx_api_keys_user      ON api_keys (user_id);
CREATE INDEX idx_nodes_datacenter   ON nodes (datacenter_id);
CREATE INDEX idx_gpus_model         ON gpus (gpu_model_id);
CREATE INDEX idx_templates_owner    ON templates (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX idx_volumes_user       ON volumes (user_id);
CREATE INDEX idx_volumes_datacenter ON volumes (datacenter_id);
CREATE INDEX idx_instances_user     ON instances (user_id);
CREATE INDEX idx_instances_node     ON instances (node_id);
CREATE INDEX idx_instances_model    ON instances (gpu_model_id);
CREATE INDEX idx_instances_template ON instances (template_id);
CREATE INDEX idx_instances_volume   ON instances (volume_id) WHERE volume_id IS NOT NULL;
CREATE INDEX idx_instance_gpus_instance ON instance_gpus (instance_id);
CREATE INDEX idx_payments_user_created  ON payments (user_id, created_at DESC);
CREATE INDEX idx_audit_actor        ON audit_log (actor_user_id) WHERE actor_user_id IS NOT NULL;

-- Инстансы: список «моих активных» (FR-13/кабинет) и выборка активных для биллинга.
-- Partial: терминированных большинство, в индекс они не попадают — он на порядок меньше полного.
CREATE INDEX idx_instances_user_active   ON instances (user_id) WHERE status <> 'terminated';
CREATE INDEX idx_instances_status_active ON instances (status)  WHERE status IN ('pending', 'running', 'stopped');

-- Один том — не более одного живого инстанса (FR-09). Последняя линия обороны после проверки в функции.
CREATE UNIQUE INDEX uq_instances_active_volume ON instances (volume_id)
    WHERE status IN ('pending', 'running', 'stopped');

-- Активные аллокации: «какие GPU заняты сейчас» для подбора GPU и каталога.
CREATE INDEX idx_instance_gpus_active ON instance_gpus (gpu_id) WHERE upper_inf(allocated_during);

-- usage_records: объявляем на родителе — PostgreSQL сам создаёт их в каждой партиции (и будущей).
CREATE INDEX idx_usage_user_period ON usage_records (user_id, period_start);
CREATE INDEX idx_usage_period_brin ON usage_records USING brin (period_start);

-- Журнал операций: история пользователя и keyset-пагинация (created_at, id).
CREATE INDEX idx_transactions_user_created ON transactions (user_id, created_at DESC, id DESC);
CREATE INDEX idx_transactions_payment      ON transactions (payment_id) WHERE payment_id IS NOT NULL;
-- Идемпотентность (п. 8.2): один платёж — одно пополнение, одно потребление — одно списание.
CREATE UNIQUE INDEX uq_transactions_topup_payment ON transactions (payment_id) WHERE type = 'topup';
CREATE UNIQUE INDEX uq_transactions_charge_usage  ON transactions (usage_id, usage_period_start) WHERE type = 'charge';

-- Аудит: поиск по содержимому details (@>, @?) и по объекту.
CREATE INDEX idx_audit_details ON audit_log USING gin (details jsonb_path_ops);
CREATE INDEX idx_audit_entity  ON audit_log (entity, entity_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('0007_indexes');
COMMIT;

-- 0004: платежи, тома, инстансы, аллокации GPU, секреты env, учёт потребления, журнал операций, аудит.
-- Согласованность владельца (п. 8.4 брифа) обеспечивается составными внешними ключами:
-- UNIQUE (id, user_id) у родителя + FK (child_id, user_id) у потомка.
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

CREATE TABLE payments (
    id                  bigint GENERATED ALWAYS AS IDENTITY,
    user_id             bigint         NOT NULL,
    provider            text           NOT NULL,
    provider_payment_id text           NOT NULL,
    amount              numeric(14,2)  NOT NULL,
    status              payment_status NOT NULL DEFAULT 'pending',
    created_at          timestamptz    NOT NULL DEFAULT now(),
    paid_at             timestamptz,
    CONSTRAINT pk_payments PRIMARY KEY (id),
    -- повторный webhook шлюза с тем же id платежа не создаёт вторую строку
    CONSTRAINT uq_payments_provider_id UNIQUE (provider, provider_payment_id),
    CONSTRAINT uq_payments_id_user UNIQUE (id, user_id),
    CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users (id),
    -- верхняя граница: сумма платежа обязана помещаться в transactions.amount numeric(14,4)
    CONSTRAINT ck_payments_amount CHECK (amount <> 'NaN' AND amount > 0 AND amount < 10000000000),
    CONSTRAINT ck_payments_paid_at CHECK ((status IN ('succeeded', 'refunded')) = (paid_at IS NOT NULL))
);

CREATE TABLE volumes (
    id             bigint GENERATED ALWAYS AS IDENTITY,
    user_id        bigint        NOT NULL,
    datacenter_id  bigint        NOT NULL,
    name           text          NOT NULL,
    size_gb        integer       NOT NULL,
    status         volume_status NOT NULL DEFAULT 'active',
    created_at     timestamptz   NOT NULL DEFAULT now(),
    deleted_at     timestamptz,
    -- ОТСТУПЛЕНИЕ ОТ БРИФА: граница биллинга хранения. Без неё пришлось бы искать max(period_end)
    -- по всем партициям usage_records для каждого тома при каждом проходе (раз в минуту).
    last_billed_at timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_volumes PRIMARY KEY (id),
    CONSTRAINT uq_volumes_id_user UNIQUE (id, user_id),
    CONSTRAINT fk_volumes_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_volumes_datacenter FOREIGN KEY (datacenter_id) REFERENCES datacenters (id),
    CONSTRAINT ck_volumes_size CHECK (size_gb BETWEEN 10 AND 10000),
    CONSTRAINT ck_volumes_deleted CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
    CONSTRAINT ck_volumes_billed CHECK (last_billed_at >= created_at)
);

CREATE TABLE instances (
    id                      uuid            NOT NULL DEFAULT gen_random_uuid(),  -- светится в URL/API
    user_id                 bigint          NOT NULL,
    node_id                 bigint          NOT NULL,
    gpu_model_id            bigint          NOT NULL,
    template_id             bigint          NOT NULL,
    volume_id               bigint,
    name                    text            NOT NULL,
    pricing_type            pricing_type    NOT NULL,
    gpu_count               smallint        NOT NULL,
    container_disk_gb       integer         NOT NULL,
    price_per_hour_snapshot numeric(14,4)   NOT NULL,  -- за ВЕСЬ инстанс (цена GPU * gpu_count) на момент запуска
    status                  instance_status NOT NULL DEFAULT 'pending',
    created_at              timestamptz     NOT NULL DEFAULT now(),
    started_at              timestamptz,
    stopped_at              timestamptz,
    terminated_at           timestamptz,
    last_billed_at          timestamptz,
    CONSTRAINT pk_instances PRIMARY KEY (id),
    CONSTRAINT uq_instances_id_user UNIQUE (id, user_id),
    CONSTRAINT fk_instances_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_instances_node FOREIGN KEY (node_id) REFERENCES nodes (id),
    CONSTRAINT fk_instances_model FOREIGN KEY (gpu_model_id) REFERENCES gpu_models (id),
    CONSTRAINT fk_instances_template FOREIGN KEY (template_id) REFERENCES templates (id),
    -- том должен принадлежать тому же пользователю, что и инстанс
    CONSTRAINT fk_instances_volume_owner FOREIGN KEY (volume_id, user_id) REFERENCES volumes (id, user_id),
    CONSTRAINT ck_instances_gpu_count CHECK (gpu_count BETWEEN 1 AND 8),
    CONSTRAINT ck_instances_disk CHECK (container_disk_gb > 0),
    CONSTRAINT ck_instances_price CHECK (price_per_hour_snapshot > 0 AND price_per_hour_snapshot <> 'NaN'),
    CONSTRAINT ck_instances_running CHECK (status <> 'running' OR (started_at IS NOT NULL AND last_billed_at IS NOT NULL)),
    CONSTRAINT ck_instances_terminated CHECK ((status = 'terminated') = (terminated_at IS NOT NULL))
);

CREATE TABLE instance_gpus (
    id               bigint GENERATED ALWAYS AS IDENTITY,  -- суррогат: выражение lower(...) в PK невозможно
    instance_id      uuid      NOT NULL,
    gpu_id           bigint    NOT NULL,
    allocated_during tstzrange NOT NULL,   -- открытый конец = GPU занята сейчас
    CONSTRAINT pk_instance_gpus PRIMARY KEY (id),
    CONSTRAINT fk_instance_gpus_instance FOREIGN KEY (instance_id) REFERENCES instances (id),
    CONSTRAINT fk_instance_gpus_gpu FOREIGN KEY (gpu_id) REFERENCES gpus (id),
    CONSTRAINT ck_instance_gpus_range CHECK (
        NOT isempty(allocated_during) AND lower_inc(allocated_during)
        AND NOT upper_inc(allocated_during) AND lower(allocated_during) IS NOT NULL),
    -- последняя линия обороны от двойной аллокации; fn_start_instance до неё не доводит
    CONSTRAINT ex_instance_gpus_no_overlap EXCLUDE USING gist (gpu_id WITH =, allocated_during WITH &&)
);

CREATE TABLE instance_env_vars (
    instance_id     uuid  NOT NULL,
    name            text  NOT NULL,
    value_encrypted bytea NOT NULL,   -- pgp_sym_encrypt; ключ приходит из app.enc_key и в БД не хранится
    CONSTRAINT pk_instance_env_vars PRIMARY KEY (instance_id, name),
    CONSTRAINT fk_instance_env_vars_instance FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE,
    CONSTRAINT ck_instance_env_vars_name CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);

-- Партиционированный родитель; сами партиции создаёт 0006.
-- Идентификатор уникален только вместе с period_start (ограничение партиционирования PG).
CREATE TABLE usage_records (
    id           bigint GENERATED ALWAYS AS IDENTITY,
    user_id      bigint        NOT NULL,   -- денормализовано: агрегации по пользователю без JOIN
    instance_id  uuid,
    volume_id    bigint,
    kind         usage_kind    NOT NULL,
    period_start timestamptz   NOT NULL,
    period_end   timestamptz   NOT NULL,
    quantity     numeric(20,6) NOT NULL,   -- секунды работы (gpu) или ГБ·с (storage)
    amount       numeric(14,4) NOT NULL,
    CONSTRAINT pk_usage_records PRIMARY KEY (id, period_start),
    -- Интервал одного объекта начинается один раз: защита от двойной записи одного и того же куска.
    -- Включает ключ партиционирования, поэтому допустима на партиционированной таблице.
    CONSTRAINT uq_usage_instance_start UNIQUE (instance_id, period_start),
    CONSTRAINT uq_usage_volume_start UNIQUE (volume_id, period_start),
    CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_usage_instance_owner FOREIGN KEY (instance_id, user_id) REFERENCES instances (id, user_id),
    CONSTRAINT fk_usage_volume_owner FOREIGN KEY (volume_id, user_id) REFERENCES volumes (id, user_id),
    CONSTRAINT ck_usage_kind_ref CHECK (
        (kind = 'gpu'     AND instance_id IS NOT NULL AND volume_id IS NULL) OR
        (kind = 'storage' AND volume_id IS NOT NULL AND instance_id IS NULL)),
    CONSTRAINT ck_usage_period CHECK (period_end > period_start),
    CONSTRAINT ck_usage_quantity CHECK (quantity > 0 AND quantity <> 'NaN'),
    CONSTRAINT ck_usage_amount CHECK (amount >= 0 AND amount <> 'NaN')
) PARTITION BY RANGE (period_start);

CREATE TABLE transactions (
    id                 bigint GENERATED ALWAYS AS IDENTITY,
    user_id            bigint        NOT NULL,
    type               tx_type       NOT NULL,
    amount             numeric(14,4) NOT NULL,   -- + пополнение, - списание
    payment_id         bigint,
    usage_id           bigint,                   -- на какое потребление выписано списание
    usage_period_start timestamptz,
    description        text          NOT NULL DEFAULT '',
    created_at         timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_transactions PRIMARY KEY (id),
    CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users (id),
    -- платёж должен принадлежать тому же пользователю, что и запись журнала
    CONSTRAINT fk_transactions_payment_owner FOREIGN KEY (payment_id, user_id) REFERENCES payments (id, user_id),
    -- FK на партиционированную таблицу возможен только по её PK (id, period_start)
    CONSTRAINT fk_transactions_usage FOREIGN KEY (usage_id, usage_period_start) REFERENCES usage_records (id, period_start),
    CONSTRAINT ck_transactions_sign CHECK (
        amount <> 'NaN' AND CASE type
            WHEN 'topup'  THEN amount > 0
            WHEN 'bonus'  THEN amount > 0
            WHEN 'charge' THEN amount < 0
            WHEN 'refund' THEN amount < 0
            ELSE amount <> 0
        END),
    CONSTRAINT ck_transactions_charge_usage CHECK (
        (type = 'charge') = (usage_id IS NOT NULL AND usage_period_start IS NOT NULL)
        AND (usage_id IS NULL) = (usage_period_start IS NULL)),
    CONSTRAINT ck_transactions_topup_payment CHECK (type <> 'topup' OR payment_id IS NOT NULL)
);

CREATE TABLE audit_log (
    id            bigint GENERATED ALWAYS AS IDENTITY,
    actor_user_id bigint,              -- NULL = системное действие (планировщик, агент ноды)
    action        text        NOT NULL,
    entity        text        NOT NULL,
    entity_id     text,
    details       jsonb       NOT NULL DEFAULT '{}',
    ip            inet,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_audit_log PRIMARY KEY (id),
    CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
);

COMMENT ON TABLE payments IS 'Платежи через шлюз. UNIQUE(provider, provider_payment_id) даёт идемпотентность webhook.';
COMMENT ON COLUMN payments.amount IS 'Сумма платежа в ₽ (2 знака), строго меньше 10^10, чтобы поместиться в transactions.amount.';
COMMENT ON TABLE volumes IS 'Сетевые тома. Живут в одном ДЦ, подключаются не более чем к одному активному инстансу.';
COMMENT ON COLUMN volumes.last_billed_at IS 'Граница биллинга хранения (отступление от брифа, см. комментарий в миграции).';
COMMENT ON TABLE instances IS 'Инстансы (поды). Статус меняют только fn_start/stop/resume/terminate и биллинг; переходы охраняет триггер.';
COMMENT ON COLUMN instances.price_per_hour_snapshot IS 'Цена за весь инстанс в час на момент запуска (фиксируется снимком, FR-10).';
COMMENT ON COLUMN instances.last_billed_at IS 'До какого момента потребление уже списано. Двигается только вперёд.';
COMMENT ON TABLE instance_gpus IS 'Выделение физических GPU инстансам по времени. Открытый верхний предел = GPU занята.';
COMMENT ON TABLE instance_env_vars IS 'Секретные переменные окружения инстанса в зашифрованном виде (pgp_sym_encrypt).';
COMMENT ON TABLE usage_records IS 'Учёт потребления (GPU и хранение), партиции по месяцам. Только добавление.';
COMMENT ON COLUMN usage_records.quantity IS 'gpu: секунды работы инстанса; storage: ГБ·секунды.';
COMMENT ON TABLE transactions IS 'Журнал операций баланса (ledger). Только добавление; users.balance — его кэш.';
COMMENT ON COLUMN transactions.usage_id IS 'Списание (charge) всегда ссылается на запись usage_records, за которую оно выписано.';
COMMENT ON TABLE audit_log IS 'Журнал аудита значимых действий (FR-18). Только добавление.';
COMMENT ON COLUMN transactions.amount IS 'Знаковая сумма: пополнения и бонусы положительные, списания и возвраты отрицательные; numeric(14,4).';
COMMENT ON COLUMN instances.status IS 'pending, running, stopped, terminated, failed; допустимые переходы проверяет триггер trg_instances_status_guard.';
COMMENT ON COLUMN instances.node_id IS 'Нода инстанса; при повторном запуске может смениться, но только в пределах того же ДЦ.';
COMMENT ON COLUMN instances.gpu_model_id IS 'Модель GPU хранится в инстансе, чтобы выручка по моделям не зависела от JOIN с аллокациями.';
COMMENT ON COLUMN usage_records.period_start IS 'Начало оплаченного интервала; ключ партиционирования (границы месяцев по UTC).';
COMMENT ON COLUMN instance_gpus.allocated_during IS 'Полуинтервал [начало, конец); открытый конец означает, что GPU занята инстансом прямо сейчас.';
COMMENT ON COLUMN audit_log.actor_user_id IS 'Кто выполнил действие (app.user_id в момент изменения); NULL — системное действие.';
COMMENT ON COLUMN audit_log.details IS 'Подробности события (старое и новое значение) в jsonb; GIN-индекс jsonb_path_ops для поиска по @>.';
COMMENT ON COLUMN payments.provider_payment_id IS 'Идентификатор платежа на стороне шлюза; вместе с provider уникален, отсюда идемпотентность webhook.';
COMMENT ON COLUMN volumes.size_gb IS 'Размер тома, 10..10000 ГБ; только увеличивается. История размеров не ведётся (известное ограничение биллинга хранения).';

INSERT INTO schema_migrations (version) VALUES ('0004_core_tables');
COMMIT;

-- 0003: пользователи, ключи, справочники инфраструктуры, цены, шаблоны.
-- Диапазоны valid_during: [начало, конец) с обязательным началом, без пустых диапазонов
-- (иначе EXCLUDE пропускает «пустой» период, который пересекается с пустотой).
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

CREATE TABLE users (
    id                bigint GENERATED ALWAYS AS IDENTITY,
    email             citext      NOT NULL,
    password_hash     text        NOT NULL,
    full_name         text        NOT NULL,
    role              user_role   NOT NULL DEFAULT 'client',
    status            user_status NOT NULL DEFAULT 'active',
    balance           numeric(14,4) NOT NULL DEFAULT 0,
    email_verified_at timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_users PRIMARY KEY (id),
    CONSTRAINT uq_users_email UNIQUE (email),
    -- в БД только bcrypt-хэш ($2a/$2b/$2y), открытый пароль сюда попасть не должен
    CONSTRAINT ck_users_password_hash CHECK (password_hash ~ '^\$2[abxy]\$[0-9]{2}\$.{53}$'),
    CONSTRAINT ck_users_email_format CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    CONSTRAINT ck_users_balance_not_nan CHECK (balance <> 'NaN')
);

CREATE TABLE api_keys (
    id           bigint GENERATED ALWAYS AS IDENTITY,
    user_id      bigint      NOT NULL,
    name         text        NOT NULL,
    key_prefix   char(8)     NOT NULL,
    key_hash     bytea       NOT NULL,
    last_used_at timestamptz,
    expires_at   timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_api_keys PRIMARY KEY (id),
    CONSTRAINT uq_api_keys_hash UNIQUE (key_hash),
    CONSTRAINT fk_api_keys_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT ck_api_keys_hash_len CHECK (octet_length(key_hash) = 32),  -- sha256
    CONSTRAINT ck_api_keys_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE ssh_keys (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    user_id     bigint      NOT NULL,
    name        text        NOT NULL,
    public_key  text        NOT NULL,
    fingerprint text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_ssh_keys PRIMARY KEY (id),
    CONSTRAINT uq_ssh_keys_user_fp UNIQUE (user_id, fingerprint),
    CONSTRAINT fk_ssh_keys_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT ck_ssh_keys_format CHECK (public_key ~ '^(ssh-|ecdsa-)')
);

CREATE TABLE datacenters (
    id        bigint GENERATED ALWAYS AS IDENTITY,
    code      text    NOT NULL,
    name      text    NOT NULL,
    city      text    NOT NULL,
    country   char(2) NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    CONSTRAINT pk_datacenters PRIMARY KEY (id),
    CONSTRAINT uq_datacenters_code UNIQUE (code),
    CONSTRAINT ck_datacenters_country CHECK (country ~ '^[A-Z]{2}$')
);

CREATE TABLE gpu_models (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    vendor      text          NOT NULL,
    name        text          NOT NULL,
    vram_gb     smallint      NOT NULL,
    fp32_tflops numeric(8,2)  NOT NULL,
    CONSTRAINT pk_gpu_models PRIMARY KEY (id),
    CONSTRAINT uq_gpu_models_name UNIQUE (name),
    CONSTRAINT ck_gpu_models_vram CHECK (vram_gb > 0),
    CONSTRAINT ck_gpu_models_tflops CHECK (fp32_tflops > 0 AND fp32_tflops <> 'NaN')
);

CREATE TABLE nodes (
    id            bigint GENERATED ALWAYS AS IDENTITY,
    datacenter_id bigint      NOT NULL,
    hostname      text        NOT NULL,
    cpu_cores     smallint    NOT NULL,
    ram_gb        integer     NOT NULL,
    disk_gb       integer     NOT NULL,
    status        node_status NOT NULL DEFAULT 'online',
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_nodes PRIMARY KEY (id),
    CONSTRAINT uq_nodes_hostname UNIQUE (hostname),
    CONSTRAINT fk_nodes_datacenter FOREIGN KEY (datacenter_id) REFERENCES datacenters (id),
    CONSTRAINT ck_nodes_resources CHECK (cpu_cores > 0 AND ram_gb > 0 AND disk_gb > 0)
);

CREATE TABLE gpus (
    id           bigint GENERATED ALWAYS AS IDENTITY,
    node_id      bigint   NOT NULL,
    gpu_model_id bigint   NOT NULL,
    slot_index   smallint NOT NULL,
    serial       text     NOT NULL,
    is_enabled   boolean  NOT NULL DEFAULT true,
    CONSTRAINT pk_gpus PRIMARY KEY (id),
    CONSTRAINT uq_gpus_serial UNIQUE (serial),
    CONSTRAINT uq_gpus_node_slot UNIQUE (node_id, slot_index),
    CONSTRAINT fk_gpus_node FOREIGN KEY (node_id) REFERENCES nodes (id),
    CONSTRAINT fk_gpus_model FOREIGN KEY (gpu_model_id) REFERENCES gpu_models (id),
    CONSTRAINT ck_gpus_slot CHECK (slot_index >= 0)
);

CREATE TABLE gpu_prices (
    id             bigint GENERATED ALWAYS AS IDENTITY,
    datacenter_id  bigint        NOT NULL,
    gpu_model_id   bigint        NOT NULL,
    pricing_type   pricing_type  NOT NULL,
    price_per_hour numeric(14,4) NOT NULL,   -- цена за ОДНУ GPU в час, ₽
    valid_during   tstzrange     NOT NULL,
    CONSTRAINT pk_gpu_prices PRIMARY KEY (id),
    CONSTRAINT fk_gpu_prices_dc FOREIGN KEY (datacenter_id) REFERENCES datacenters (id),
    CONSTRAINT fk_gpu_prices_model FOREIGN KEY (gpu_model_id) REFERENCES gpu_models (id),
    CONSTRAINT ck_gpu_prices_price CHECK (price_per_hour > 0 AND price_per_hour <> 'NaN'),
    CONSTRAINT ck_gpu_prices_range CHECK (
        NOT isempty(valid_during) AND lower_inc(valid_during)
        AND NOT upper_inc(valid_during) AND lower(valid_during) IS NOT NULL),
    -- один и тот же товар не может иметь две цены на одну секунду
    CONSTRAINT ex_gpu_prices_no_overlap EXCLUDE USING gist (
        datacenter_id WITH =, gpu_model_id WITH =, pricing_type WITH =, valid_during WITH &&)
);

CREATE TABLE storage_prices (
    id                 bigint GENERATED ALWAYS AS IDENTITY,
    datacenter_id      bigint        NOT NULL,
    price_per_gb_month numeric(14,4) NOT NULL,   -- ₽ за ГБ в месяц (30 суток)
    valid_during       tstzrange     NOT NULL,
    CONSTRAINT pk_storage_prices PRIMARY KEY (id),
    CONSTRAINT fk_storage_prices_dc FOREIGN KEY (datacenter_id) REFERENCES datacenters (id),
    CONSTRAINT ck_storage_prices_price CHECK (price_per_gb_month > 0 AND price_per_gb_month <> 'NaN'),
    CONSTRAINT ck_storage_prices_range CHECK (
        NOT isempty(valid_during) AND lower_inc(valid_during)
        AND NOT upper_inc(valid_during) AND lower(valid_during) IS NOT NULL),
    CONSTRAINT ex_storage_prices_no_overlap EXCLUDE USING gist (
        datacenter_id WITH =, valid_during WITH &&)
);

CREATE TABLE templates (
    id              bigint GENERATED ALWAYS AS IDENTITY,
    owner_id        bigint,
    name            text    NOT NULL,
    docker_image    text    NOT NULL,
    default_disk_gb integer NOT NULL,
    default_ports   text    NOT NULL DEFAULT '',
    is_public       boolean NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_templates PRIMARY KEY (id),
    CONSTRAINT fk_templates_owner FOREIGN KEY (owner_id) REFERENCES users (id),
    CONSTRAINT ck_templates_disk CHECK (default_disk_gb > 0),
    -- публичный <=> без владельца
    CONSTRAINT ck_templates_public_owner CHECK (is_public = (owner_id IS NULL))
);

COMMENT ON TABLE users IS 'Учётные записи клиентов и администраторов. balance — денормализованный кэш суммы transactions.';
COMMENT ON COLUMN users.balance IS 'ДЕНОРМАЛИЗАЦИЯ: сумма transactions пользователя. Меняется только триггером журнала, прямой UPDATE запрещён.';
COMMENT ON COLUMN users.password_hash IS 'bcrypt-хэш (считается в приложении), открытый пароль в БД не попадает.';
COMMENT ON TABLE api_keys IS 'API-ключи: хранится только sha256-хэш, исходный ключ показывается пользователю один раз.';
COMMENT ON TABLE datacenters IS 'Дата-центры. Сетевой том и нода инстанса должны принадлежать одному ДЦ.';
COMMENT ON TABLE nodes IS 'Физические серверы ДЦ. datacenter_id неизменяем.';
COMMENT ON TABLE gpus IS 'Физические GPU нод. Занятость определяется по instance_gpus, а не полем самой GPU.';
COMMENT ON TABLE gpu_prices IS 'История цен за 1 GPU-час по ДЦ, модели и тарифу. Периоды не пересекаются (EXCLUDE).';
COMMENT ON COLUMN gpu_prices.valid_during IS 'Полуинтервал [начало, конец); конец NULL = действует сейчас.';
COMMENT ON TABLE storage_prices IS 'История цен хранения (₽ за ГБ в месяц, месяц = 30 суток) по ДЦ.';
COMMENT ON COLUMN gpu_prices.price_per_hour IS 'Цена за одну GPU в час, ₽; цена инстанса = price_per_hour * gpu_count.';
COMMENT ON COLUMN storage_prices.price_per_gb_month IS '₽ за ГБ в месяц; месяц для посекундного расчёта принят равным 30 суткам.';
COMMENT ON COLUMN nodes.datacenter_id IS 'ДЦ ноды; неизменяем, на этом держится проверка «том и нода в одном ДЦ».';
COMMENT ON COLUMN gpus.is_enabled IS 'false — GPU выведена из эксплуатации: не выделяется новым инстансам, текущую аллокацию не прерывает.';
COMMENT ON COLUMN users.role IS 'client или admin; смена роли попадает в audit_log.';
COMMENT ON COLUMN users.status IS 'active или blocked; смена статуса попадает в audit_log, blocked не может запускать инстансы.';
COMMENT ON TABLE templates IS 'Шаблоны запуска: публичные (owner_id IS NULL) и приватные пользовательские.';

INSERT INTO schema_migrations (version) VALUES ('0003_reference_tables');
COMMIT;

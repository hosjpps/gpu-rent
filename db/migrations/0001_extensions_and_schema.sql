-- 0001: расширения, схема gpu_rent, роли кластера, журнал версий миграций.
-- Выполняется суперпользователем: CREATE EXTENSION и создание ролей требуют прав выше обычных.
-- pg_stat_statements не создаётся: расширению нужен shared_preload_libraries и перезапуск
-- сервера, это настройка окружения (см. раздел эксплуатации), а не схемы БД.
BEGIN;

DO $$
BEGIN
    -- Роли принадлежат кластеру, а не БД, поэтому создаём идемпотентно.
    -- Все три NOLOGIN: подключаться к ним напрямую нельзя, приложение получает
    -- свой LOGIN-пользователь и делает GRANT gpu_rent_app (пароль не хранится в репозитории).
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gpu_rent_owner') THEN
        CREATE ROLE gpu_rent_owner NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gpu_rent_app') THEN
        CREATE ROLE gpu_rent_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gpu_rent_analyst') THEN
        CREATE ROLE gpu_rent_analyst NOLOGIN;
    END IF;
END
$$;

-- Параметры БД: UTC, чтобы границы месячных партиций не зависели от часового пояса сессии;
-- search_path — чтобы все роли видели объекты схемы без префикса.
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
    EXECUTE format('ALTER DATABASE %I SET search_path TO %L', current_database(), 'gpu_rent');
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO gpu_rent_owner, gpu_rent_app, gpu_rent_analyst',
                   current_database());
    -- REFRESH MATERIALIZED VIEW CONCURRENTLY создаёт временную таблицу: владельцу витрины нужно право TEMP
    EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO gpu_rent_owner', current_database());
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS gpu_rent AUTHORIZATION gpu_rent_owner;

-- Расширения кладём в схему gpu_rent: одна схема — один search_path для всех функций.
CREATE EXTENSION IF NOT EXISTS pgcrypto   WITH SCHEMA gpu_rent;  -- pgp_sym_encrypt, digest, crypt
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA gpu_rent;  -- = для скаляров внутри EXCLUDE USING gist
CREATE EXTENSION IF NOT EXISTS citext     WITH SCHEMA gpu_rent;  -- email без учёта регистра

-- Функции, которые создаёт владелец, по умолчанию доступны PUBLIC; отключаем это глобально,
-- а нужным ролям выдаём EXECUTE явно в 0011.
ALTER DEFAULT PRIVILEGES FOR ROLE gpu_rent_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Дальше все объекты создаёт владелец схемы, а не суперпользователь.
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

CREATE TABLE schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE schema_migrations IS 'Журнал применённых миграций (NFR-08): одна строка на файл db/migrations.';

INSERT INTO schema_migrations (version) VALUES ('0001_extensions_and_schema');

COMMIT;

-- 0002: enum-типы статусов и видов. Значения фиксированы первоначальным проектом (П3); порядок в инстансе
-- (pending -> running -> ...) охраняется триггером, а не порядком enum.
BEGIN;
SET LOCAL ROLE gpu_rent_owner;
SET LOCAL search_path = gpu_rent, pg_catalog;

CREATE TYPE user_role       AS ENUM ('client', 'admin');
CREATE TYPE user_status     AS ENUM ('active', 'blocked');
CREATE TYPE node_status     AS ENUM ('online', 'maintenance', 'offline');
CREATE TYPE pricing_type    AS ENUM ('on_demand', 'spot');
CREATE TYPE volume_status   AS ENUM ('active', 'deleted');
CREATE TYPE instance_status AS ENUM ('pending', 'running', 'stopped', 'terminated', 'failed');
CREATE TYPE usage_kind      AS ENUM ('gpu', 'storage');
CREATE TYPE tx_type         AS ENUM ('topup', 'charge', 'refund', 'bonus', 'adjustment');
CREATE TYPE payment_status  AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

COMMENT ON TYPE tx_type IS
    'topup (+) пополнение, charge (-) списание за потребление, refund (-) возврат платежа на карту, '
    'bonus (+) начисление без платежа, adjustment (+/-) ручная корректировка.';

INSERT INTO schema_migrations (version) VALUES ('0002_types');
COMMIT;

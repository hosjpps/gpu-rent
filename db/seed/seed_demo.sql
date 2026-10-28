-- Компактный демо-сид GPU Rent для веб-приложения (Vercel + Neon, бесплатный тариф 0,5 ГБ): те же 4 ДЦ и 6 моделей GPU,
-- 21 нода и 120 GPU, 52 пользователя (admin, demo и 50 клиентов), история за 90 суток (около 800 инстансов,
-- десятки тысяч записей потребления) и журнал операций, согласованный с балансами. Полный сид (seed.sql) для БД
-- такого размера не годится: после загрузки он занимает около 600 МБ.
--
-- Запуск (после миграций, под владельцем или суперпользователем):
--   DEMO_PASSWORD=... ADMIN_PASSWORD=... db/scripts/reset.sh --demo
--   psql -v demo_password=... -v admin_password=... -f db/seed/seed_demo.sql
-- Пароли в репозитории не хранятся: их задаёт тот, кто загружает сид (переменная psql или окружения).
-- Остальные пользователи получают хэш правильного формата, войти под ними нельзя.
--
-- Детерминизм: структура данных (кто, когда, сколько) задана setseed и ORDER BY, но привязана к «сейчас» загрузки:
-- иначе работающие инстансы с границей биллинга в прошлом начислили бы разом за недели простоя. Для повторяемого
-- результата момент можно задать: -v seed_now='2026-10-28 12:00:00+00'. Сид рассчитан на использование сразу после
-- загрузки: у владельцев работающих инстансов запас на 3 суток работы.
-- Секреты env-переменных инстансов в демо-сид не входят: ключ шифрования задаёт приложение, а не репозиторий.
\set ON_ERROR_STOP on

\if :{?demo_password}
\else
\getenv demo_password DEMO_PASSWORD
\endif
\if :{?admin_password}
\else
\getenv admin_password ADMIN_PASSWORD
\endif
\if :{?demo_password}
\if :{?admin_password}
\else
\echo 'Ошибка: не задан пароль admin. Передайте -v admin_password=... или переменную окружения ADMIN_PASSWORD.'
DO $$ BEGIN RAISE EXCEPTION 'admin_password is not set'; END $$;
\endif
\else
\echo 'Ошибка: не задан пароль demo. Передайте -v demo_password=... или переменную окружения DEMO_PASSWORD.'
DO $$ BEGIN RAISE EXCEPTION 'demo_password is not set'; END $$;
\endif

SELECT (length(:'demo_password') < 8 OR length(:'admin_password') < 8) AS pw_short \gset
\if :pw_short
\echo 'Ошибка: пароли demo и admin должны быть не короче 8 символов.'
DO $$ BEGIN RAISE EXCEPTION 'passwords of demo and admin must be at least 8 characters long'; END $$;
\endif

SET timezone = 'UTC';
\if :{?seed_now}
\else
SELECT to_char(date_trunc('minute', now()), 'YYYY-MM-DD HH24:MI:SS') || '+00' AS seed_now \gset
\endif

BEGIN;
SET LOCAL timezone = 'UTC';
SET LOCAL search_path = gpu_rent, pg_catalog;
SET LOCAL synchronous_commit = off;
SET LOCAL max_parallel_workers_per_gather = 0;   -- random() в параллельных воркерах давал бы недетерминированный порядок
SELECT setseed(0.4242) \g /dev/null

DO $$
BEGIN
    IF (SELECT count(*) FROM users) > 0 THEN
        RAISE EXCEPTION 'database is not empty: seed_demo.sql expects freshly migrated database (db/scripts/reset.sh --demo)';
    END IF;
END
$$;

-- Параметры окна данных: все даты относительны seed_now.
CREATE TEMP TABLE _p AS
SELECT :'seed_now'::timestamptz                       AS seed_now,
       :'seed_now'::timestamptz - interval '90 days'  AS win_start,
       :'seed_now'::timestamptz - interval '120 days' AS user_t0;

ALTER TABLE transactions DISABLE TRIGGER trg_transactions_ledger;
ALTER TABLE users        DISABLE TRIGGER trg_users_guard;

-- Партиции usage_records на весь период данных (миграция 0006 создаёт только 2025-10 .. 2026-12).
SELECT set_config('app.user_role', 'system', true) \g /dev/null
SELECT fn_ensure_usage_partition(m::date)
FROM _p, generate_series(date_trunc('month', _p.win_start), date_trunc('month', _p.seed_now) + interval '1 month', interval '1 month') AS m \g /dev/null
SELECT set_config('app.user_role', '', true) \g /dev/null

-- ============================================================================================
-- 1. Справочники: ДЦ, модели, ноды, GPU, цены
-- ============================================================================================
INSERT INTO datacenters (code, name, city, country) VALUES
    ('MSK-1', 'Москва, ДЦ «Север»',        'Москва',          'RU'),
    ('SPB-1', 'Санкт-Петербург, ДЦ «Нева»', 'Санкт-Петербург', 'RU'),
    ('NSK-1', 'Новосибирск, ДЦ «Сибирь»',  'Новосибирск',     'RU'),
    ('KZN-1', 'Казань, ДЦ «Волга»',         'Казань',          'RU');

INSERT INTO gpu_models (vendor, name, vram_gb, fp32_tflops) VALUES
    ('NVIDIA', 'RTX 3090',   24, 35.58),
    ('NVIDIA', 'RTX 4090',   24, 82.58),
    ('NVIDIA', 'RTX A6000',  48, 38.71),
    ('NVIDIA', 'L40S',       48, 91.61),
    ('NVIDIA', 'A100 80GB',  80, 19.49),
    ('NVIDIA', 'H100 80GB',  80, 66.91);

-- План инфраструктуры: ДЦ, модель, число нод, GPU в ноде. Итого 21 нода и 120 GPU.
CREATE TEMP TABLE _plan (dc text, model text, slug text, nodes int, gpus_per int);
INSERT INTO _plan VALUES
    ('MSK-1', 'RTX 3090',  '3090', 1, 4), ('MSK-1', 'RTX 4090',  '4090', 2, 8), ('MSK-1', 'RTX A6000', 'a6000', 1, 4),
    ('MSK-1', 'L40S',      'l40s', 1, 4), ('MSK-1', 'A100 80GB', 'a100', 1, 8), ('MSK-1', 'H100 80GB', 'h100', 1, 8),
    ('SPB-1', 'RTX 3090',  '3090', 1, 4), ('SPB-1', 'RTX 4090',  '4090', 2, 8), ('SPB-1', 'RTX A6000', 'a6000', 1, 4),
    ('SPB-1', 'L40S',      'l40s', 1, 4), ('SPB-1', 'A100 80GB', 'a100', 1, 4),
    ('NSK-1', 'RTX 3090',  '3090', 1, 4), ('NSK-1', 'RTX 4090',  '4090', 1, 8), ('NSK-1', 'L40S',      'l40s', 1, 4),
    ('KZN-1', 'RTX 4090',  '4090', 2, 8), ('KZN-1', 'A100 80GB', 'a100', 1, 4), ('KZN-1', 'H100 80GB', 'h100', 1, 4),
    ('KZN-1', 'RTX A6000', 'a6000', 1, 4);

CREATE TEMP TABLE _node_src AS
SELECT row_number() OVER (ORDER BY d.id, m.id, i)::int AS ord,
       lower(replace(pl.dc, '-', '')) || '-' || pl.slug || '-' || lpad(i::text, 2, '0') AS hostname,
       d.id AS dc_id, m.id AS model_id, pl.gpus_per
FROM _plan pl
JOIN datacenters d ON d.code = pl.dc
JOIN gpu_models  m ON m.name = pl.model
CROSS JOIN LATERAL generate_series(1, pl.nodes) AS i;

INSERT INTO nodes (datacenter_id, hostname, cpu_cores, ram_gb, disk_gb, status, created_at)
SELECT dc_id, hostname, gpus_per * 8, gpus_per * 64, gpus_per * 500, 'online',
       (SELECT user_t0 FROM _p) - interval '30 days' + ord * interval '1 day'
FROM _node_src ORDER BY ord;

-- Нода на обслуживании и выключенная: в каталоге они не дают свободных GPU.
UPDATE nodes SET status = 'maintenance' WHERE hostname = 'spb1-a100-01';
UPDATE nodes SET status = 'offline'     WHERE hostname = 'nsk1-l40s-01';

INSERT INTO gpus (node_id, gpu_model_id, slot_index, serial, is_enabled)
SELECT n.id, s.model_id, slot, 'SN' || upper(substr(md5('gpu-' || n.id || '-' || slot), 1, 12)),
       (n.id * 8 + slot) % 29 <> 0          -- несколько GPU выведено из эксплуатации
FROM _node_src s
JOIN nodes n ON n.hostname = s.hostname
CROSS JOIN LATERAL generate_series(0, s.gpus_per - 1) AS slot
ORDER BY n.id, slot;

-- История цен: три периода, цена растёт; ДЦ вносят региональный коэффициент; спот на 44-48 % дешевле.
CREATE TEMP TABLE _base_price (model text, od numeric);
INSERT INTO _base_price VALUES ('RTX 3090', 48), ('RTX 4090', 75), ('RTX A6000', 95), ('L40S', 140), ('A100 80GB', 285), ('H100 80GB', 520);
CREATE TEMP TABLE _dc_factor (dc text, f numeric);
INSERT INTO _dc_factor VALUES ('MSK-1', 1.00), ('SPB-1', 0.97), ('NSK-1', 0.92), ('KZN-1', 0.95);
CREATE TEMP TABLE _period (n int, from_ts timestamptz, to_ts timestamptz, pf numeric, spot_ratio numeric);
INSERT INTO _period
SELECT v.n,
       date_trunc('day', p.seed_now - v.from_ago), CASE WHEN v.to_ago IS NULL THEN NULL ELSE date_trunc('day', p.seed_now - v.to_ago) END,
       v.pf, v.spot_ratio
FROM _p p, (VALUES (1, interval '110 days', interval '65 days', 1.00, 0.55),
                   (2, interval '65 days',  interval '30 days', 1.06, 0.52),
                   (3, interval '30 days',  NULL::interval,     1.03, 0.56)) AS v(n, from_ago, to_ago, pf, spot_ratio);

INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during)
SELECT d.id, m.id, t.pt,
       CASE t.pt WHEN 'on_demand' THEN round(b.od * f.f * p.pf, 2)
                 ELSE                  round(b.od * f.f * p.pf * p.spot_ratio, 2) END,
       tstzrange(p.from_ts, p.to_ts, '[)')
FROM _plan pl
JOIN datacenters d ON d.code = pl.dc
JOIN gpu_models  m ON m.name = pl.model
JOIN _base_price b ON b.model = pl.model
JOIN _dc_factor  f ON f.dc = pl.dc
CROSS JOIN _period p
CROSS JOIN (VALUES ('on_demand'::pricing_type), ('spot'::pricing_type)) AS t(pt)
ORDER BY d.id, m.id, t.pt, p.n;

-- Триггер аудита записал вставки цен со временем загрузки; относим их к началу действия цены, чтобы журнал
-- не зависел от момента запуска. Запрет правки журнала снимается только на этот UPDATE.
ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_append_only;
UPDATE audit_log a SET created_at = lower(p.valid_during)
FROM gpu_prices p
WHERE a.action = 'gpu_price.insert' AND a.entity_id = p.id::text;
ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_append_only;

INSERT INTO storage_prices (datacenter_id, price_per_gb_month, valid_during)
SELECT d.id, round(9.00 * f.f * p.pf, 2), tstzrange(p.from_ts, p.to_ts, '[)')
FROM datacenters d
JOIN _dc_factor f ON f.dc = d.code
CROSS JOIN _period p
ORDER BY d.id, p.n;

-- ============================================================================================
-- 2. Пользователи (id = порядковый номер; 1 - администратор, 2 - демо-клиент, 3..52 - клиенты)
-- ============================================================================================
-- Регистрируются равномерно-ускоренно с user_t0 до seed_now - 2 суток: id растёт вместе с датой регистрации.
INSERT INTO users (id, email, password_hash, full_name, role, status, email_verified_at, created_at, updated_at)
OVERRIDING SYSTEM VALUE
SELECT u.n,
       CASE u.n WHEN 1 THEN 'admin@gpu-rent.example'
                WHEN 2 THEN 'demo@gpu-rent.example'
                ELSE 'user' || lpad(u.n::text, 4, '0') || '@example.com' END,
       CASE u.n WHEN 1 THEN crypt(:'admin_password', gen_salt('bf', 12))
                WHEN 2 THEN crypt(:'demo_password',  gen_salt('bf', 12))
                ELSE '$2b$12$' || substr(translate(encode(digest(u.n || 'x', 'sha256'), 'base64')
                                                   || encode(digest(u.n || 'y', 'sha256'), 'base64'), '+=' || E'\n', '.AA'), 1, 53) END,
       CASE u.n WHEN 1 THEN 'Администратор Системы'
                WHEN 2 THEN 'Демонстрационный Клиент'
                ELSE (ARRAY['Иванов','Петров','Сидоров','Смирнов','Кузнецов','Попов','Васильев','Соколов','Михайлов','Новиков',
                            'Фёдоров','Морозов','Волков','Алексеев','Лебедев','Семёнов','Егоров','Павлов','Козлов','Степанов',
                            'Николаев','Орлов','Андреев','Макаров','Никитин','Захаров','Зайцев','Соловьёв','Борисов','Яковлев'])[1 + (u.n * 31 + 7) % 30]
                     || CASE WHEN u.n % 2 = 0 THEN '' ELSE 'а' END
                     || ' ' || CASE WHEN u.n % 2 = 0
                                    THEN (ARRAY['Александр','Дмитрий','Максим','Сергей','Андрей','Алексей','Артём','Илья','Кирилл','Михаил',
                                                'Никита','Матвей','Роман','Егор','Арсений','Иван','Денис','Евгений','Даниил','Тимофей'])[1 + (u.n * 17 + 3) % 20]
                                    ELSE (ARRAY['Анна','Мария','Елена','Ольга','Наталья','Екатерина','Татьяна','Ирина','Светлана','Юлия',
                                                'Анастасия','Дарья','Полина','Виктория','Алиса','Ксения','Софья','Александра','Марина','Вера'])[1 + (u.n * 17 + 3) % 20] END
                     || ' ' || CASE WHEN u.n % 2 = 0
                                    THEN (ARRAY['Александрович','Дмитриевич','Сергеевич','Андреевич','Алексеевич','Иванович','Михайлович','Николаевич',
                                                'Владимирович','Павлович','Петрович','Олегович','Игоревич','Викторович','Юрьевич','Анатольевич',
                                                'Денисович','Романович','Евгеньевич','Максимович'])[1 + (u.n * 13 + 5) % 20]
                                    ELSE (ARRAY['Александровна','Дмитриевна','Сергеевна','Андреевна','Алексеевна','Ивановна','Михайловна','Николаевна',
                                                'Владимировна','Павловна','Петровна','Олеговна','Игоревна','Викторовна','Юрьевна','Анатольевна',
                                                'Денисовна','Романовна','Евгеньевна','Максимовна'])[1 + (u.n * 13 + 5) % 20] END
                END,
       CASE WHEN u.n = 1 THEN 'admin'::user_role ELSE 'client'::user_role END,
       CASE WHEN u.n > 2 AND u.n % 17 = 0 THEN 'blocked'::user_status ELSE 'active'::user_status END,
       CASE WHEN u.n <= 2 OR u.n % 9 <> 0 THEN u.created_at + (u.n % 120) * interval '1 minute' END,
       u.created_at,
       u.created_at
FROM (SELECT n, date_trunc('second', p.user_t0 + (p.seed_now - interval '2 days' - p.user_t0) * power(n / 52.0, 0.85)) AS created_at
      FROM _p p, generate_series(1, 52) AS n) u
ORDER BY u.n;

-- SSH- и API-ключи
INSERT INTO ssh_keys (user_id, name, public_key, fingerprint, created_at)
SELECT u.id,
       (ARRAY['laptop','work-pc','ci-runner','home','cloud-shell'])[1 + k % 5],
       'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI' || substr(encode(digest('ssh' || k, 'sha256'), 'base64'), 1, 43) || ' user@host',
       'SHA256:' || replace(encode(digest('fp' || k, 'sha256'), 'base64'), '=', ''),
       u.created_at + interval '1 day'
FROM generate_series(1, 30) k
JOIN users u ON u.id = CASE WHEN k <= 2 THEN 2 ELSE 3 + (k * 13) % 50 END
ORDER BY k;

INSERT INTO api_keys (user_id, name, key_prefix, key_hash, last_used_at, expires_at, revoked_at, created_at)
SELECT u.id, (ARRAY['ci','notebook','backend','cli'])[1 + k % 4],
       'gr_' || substr(md5('p' || k), 1, 5),
       digest('api-key-' || k, 'sha256'),
       CASE WHEN k % 5 <> 0 THEN least((SELECT seed_now FROM _p), u.created_at + interval '1 day' * (k % 20 + 2)) END,
       CASE WHEN k % 2 = 0 THEN u.created_at + interval '1 day' + interval '365 days' END,
       CASE WHEN k % 10 = 0 THEN least((SELECT seed_now FROM _p), u.created_at + interval '1 day' * (k % 15 + 3)) END,
       u.created_at + interval '1 day'
FROM generate_series(1, 12) k
JOIN users u ON u.id = 3 + (k * 29) % 50
ORDER BY k;

-- ============================================================================================
-- 3. Шаблоны и тома
-- ============================================================================================
INSERT INTO templates (id, owner_id, name, docker_image, default_disk_gb, default_ports, is_public, created_at)
OVERRIDING SYSTEM VALUE
SELECT t.*, (SELECT user_t0 FROM _p) FROM (VALUES
    (1, NULL::bigint, 'PyTorch 2.4 (CUDA 12.4)',       'pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel',       50,  '22/tcp,8888/http', true),
    (2, NULL, 'JupyterLab + PyTorch',          'quay.io/jupyter/pytorch-notebook:cuda12-latest',    40,  '8888/http',        true),
    (3, NULL, 'Stable Diffusion WebUI',        'ghcr.io/ai-dock/stable-diffusion-webui:latest',     80,  '7860/http',        true),
    (4, NULL, 'ComfyUI',                       'ghcr.io/ai-dock/comfyui:latest',                    80,  '8188/http',        true),
    (5, NULL, 'TensorFlow 2.16 GPU + Jupyter', 'tensorflow/tensorflow:2.16.1-gpu-jupyter',          50,  '8888/http',        true),
    (6, NULL, 'Text Generation Inference',     'ghcr.io/huggingface/text-generation-inference:latest', 100, '8080/http',     true),
    (7, NULL, 'Ollama',                        'ollama/ollama:latest',                              100, '11434/http',       true),
    (8, NULL, 'CUDA 12.4 devel (Ubuntu 22.04)', 'nvidia/cuda:12.4.1-devel-ubuntu22.04',            30,  '22/tcp',           true)
) AS t(id, owner_id, name, docker_image, default_disk_gb, default_ports, is_public);

SELECT setval(pg_get_serial_sequence('templates', 'id'), 8) \g /dev/null

INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, default_ports, is_public, created_at)
SELECT u.id, 'my-env-' || u.id, 'registry.example.com/team' || u.id || '/env:latest', 60, '22/tcp', false, u.created_at + interval '3 days'
FROM users u WHERE u.id > 2 AND u.id % 10 = 0
ORDER BY u.id;

-- Сетевые тома: не больше одного на пару (пользователь, ДЦ); у demo один том в MSK-1.
CREATE TEMP TABLE _vol AS
SELECT row_number() OVER (ORDER BY u.id, v.slot)::int AS vid, u.id AS user_id, v.dc_no, v.slot,
       CASE WHEN u.id = 2 THEN 100 ELSE (ARRAY[50, 100, 200, 500, 1000])[1 + (u.id + v.slot) % 5] END AS size_gb,
       least(p.seed_now - interval '1 day',
             greatest(u.created_at + (u.id % 500) * interval '1 hour', p.win_start + (u.id % 60) * interval '1 hour')) AS created_at,
       (u.id % 13 = 0 AND v.slot = 1) AS will_delete
FROM _p p, users u
CROSS JOIN LATERAL (VALUES (1, CASE WHEN u.id = 2 THEN 1 ELSE 1 + u.id % 4 END), (2, 1 + (u.id + 1) % 4)) AS v(slot, dc_no)
WHERE u.id >= 2 AND ((v.slot = 1 AND (u.id = 2 OR u.id % 3 = 0)) OR (v.slot = 2 AND u.id > 2 AND u.id % 9 = 0));

INSERT INTO volumes (id, user_id, datacenter_id, name, size_gb, status, created_at, deleted_at, last_billed_at)
OVERRIDING SYSTEM VALUE
SELECT v.vid, v.user_id, v.dc_no, CASE WHEN v.user_id = 2 THEN 'demo-data' ELSE 'data-' || v.vid END, v.size_gb,
       CASE WHEN v.will_delete THEN 'deleted'::volume_status ELSE 'active'::volume_status END,
       v.created_at,
       CASE WHEN v.will_delete THEN least(p.seed_now - interval '12 hours', v.created_at + (20 + v.vid % 40) * interval '1 day') END,
       CASE WHEN v.will_delete THEN least(p.seed_now - interval '12 hours', v.created_at + (20 + v.vid % 40) * interval '1 day')
            ELSE p.seed_now END
FROM _vol v, _p p
ORDER BY v.vid;

-- ============================================================================================
-- 4. Инстансы: на каждой «линии» (группе GPU одной ноды) задания идут друг за другом без наложений
-- ============================================================================================
-- Линия = lane_size соседних GPU одной ноды. Аллокации внутри линии по построению не пересекаются, поэтому
-- EXCLUDE на instance_gpus принимает сид без конфликтов.
CREATE TEMP TABLE _lane AS
WITH nk AS (
    SELECT n.id AS node_id, n.datacenter_id, n.status AS node_status, (array_agg(g.gpu_model_id))[1] AS model_id, count(*)::int AS k
    FROM nodes n JOIN gpus g ON g.node_id = n.id
    GROUP BY n.id, n.datacenter_id, n.status
), sz AS (
    SELECT nk.*,
           CASE WHEN k >= 8 THEN (ARRAY[1, 1, 2, 4, 8, 8, 1, 2])[1 + (node_id * 7) % 8]
                WHEN k >= 4 THEN (ARRAY[1, 1, 2, 4])[1 + (node_id * 5) % 4]
                ELSE 1 END AS lane_size
    FROM nk
)
SELECT row_number() OVER (ORDER BY node_id, s)::int AS lane_id, node_id, datacenter_id, node_status, model_id, lane_size, s AS first_slot
FROM sz CROSS JOIN LATERAL generate_series(0, k - 1, lane_size) AS s;

-- Кандидаты в задания: случайные паузы (экспоненциальные, среднее 28 ч) и длительности (3,5 ч .. 6 суток, логарифмически равномерно).
CREATE TEMP TABLE _job_raw AS
WITH raw AS (
    SELECT l.lane_id, n,
           -ln(1.0 - random()) * 28.0                        AS gap_h,
           least(144.0, 3.5 * power(2.0, 5.5 * random()))    AS dur_h
    FROM _lane l CROSS JOIN generate_series(1, 60) AS n
), cum AS (
    SELECT lane_id, n, dur_h,
           sum(gap_h + dur_h) OVER (PARTITION BY lane_id ORDER BY n) - dur_h AS start_off_h
    FROM raw
)
SELECT lane_id, n,
       date_trunc('second', p.win_start + start_off_h * interval '1 hour')           AS start_ts,
       date_trunc('second', p.win_start + (start_off_h + dur_h) * interval '1 hour') AS plan_end_ts
FROM cum, _p p
WHERE p.win_start + start_off_h * interval '1 hour' < p.seed_now;

-- Ровно 800 заданий: из кандидатов остаются первые по хэшу (детерминированная «случайная» выборка).
CREATE TEMP TABLE _sel AS
SELECT row_number() OVER (ORDER BY j.start_ts, j.lane_id)::int AS seq,
       j.lane_id, j.start_ts, j.plan_end_ts,
       l.node_id, l.datacenter_id, l.node_status, l.model_id, l.lane_size AS gpu_count, l.first_slot
FROM (SELECT j.*, row_number() OVER (ORDER BY md5(j.lane_id::text || ':' || j.n::text)) AS pick FROM _job_raw j) j
JOIN _lane l ON l.lane_id = j.lane_id
WHERE j.pick <= 800;

-- Владелец, тариф, шаблон, диск, предварительный статус. Владельцы — среди уже зарегистрированных к началу задания,
-- старые пользователи встречаются чаще; каждое 40-е задание принадлежит demo.
CREATE TEMP TABLE _i1 AS
WITH rnd AS (
    SELECT s.*, random() AS r_user, random() AS r_type, random() AS r_tpl, random() AS r_disk, random() AS r_stat, random() AS r_vol
    FROM _sel s
), usr AS (
    SELECT r.*,
           least(52, greatest(8, floor(52 * power(extract(epoch FROM r.start_ts - p.user_t0)
                                                  / extract(epoch FROM p.seed_now - interval '2 days' - p.user_t0), 1 / 0.85))::int)) AS nvis
    FROM rnd r, _p p
)
SELECT u.seq, u.lane_id, u.node_id, u.datacenter_id, u.node_status, u.model_id, u.gpu_count, u.first_slot, u.start_ts, u.plan_end_ts,
       CASE WHEN u.seq % 40 = 0 THEN 2 ELSE 3 + floor((u.nvis - 2) * power(u.r_user, 1.6))::int END AS user_id,
       CASE WHEN u.r_type < 0.25 THEN 'spot'::pricing_type ELSE 'on_demand'::pricing_type END AS pricing_type,
       1 + floor(u.r_tpl * 8)::int AS template_id,
       (ARRAY[30, 50, 100, 200])[1 + floor(u.r_disk * 4)::int] AS container_disk_gb,
       u.r_stat, u.r_vol,
       (u.plan_end_ts > p.seed_now) AS crosses_now
FROM usr u, _p p;

-- Снимок цены = цена GPU на момент старта * число GPU; предварительный статус и фактический конец.
CREATE TEMP TABLE _i2 AS
SELECT i.*,
       round(gp.price_per_hour * i.gpu_count, 4) AS price_snapshot,
       CASE WHEN i.crosses_now THEN p.seed_now ELSE i.plan_end_ts END AS end_ts,
       CASE WHEN i.crosses_now THEN (CASE WHEN i.node_status = 'online' AND us.status = 'active' THEN 'running' ELSE 'stopped' END)
            WHEN i.r_stat < 0.02 THEN 'failed'
            WHEN i.r_stat < 0.12 THEN 'stopped'
            ELSE 'terminated' END AS status0
FROM _i1 i
CROSS JOIN _p p
JOIN users us ON us.id = i.user_id
JOIN gpu_prices gp ON gp.datacenter_id = i.datacenter_id AND gp.gpu_model_id = i.model_id
                  AND gp.pricing_type = i.pricing_type AND gp.valid_during @> i.start_ts;

-- Тома: к заданию подключается том владельца в том же ДЦ (не у всех). Подключения одного тома не пересекаются
-- по времени, а живой (stopped/running) инстанс остаётся только у последнего подключения тома.
CREATE TEMP TABLE _i3 AS
WITH cand AS (
    SELECT i.seq, v.id AS volume_id, i.start_ts, i.end_ts
    FROM _i2 i
    JOIN volumes v ON v.user_id = i.user_id AND v.datacenter_id = i.datacenter_id
                  AND v.created_at <= i.start_ts AND (v.deleted_at IS NULL OR v.deleted_at >= i.end_ts)
    WHERE i.r_vol < 0.45 AND i.status0 <> 'failed'
), kept AS (
    SELECT c.*,
           c.start_ts >= coalesce(max(c.end_ts) OVER (PARTITION BY c.volume_id ORDER BY c.start_ts, c.seq
                                                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), '-infinity') AS ok
    FROM cand c
), last_kept AS (
    SELECT k.seq, k.volume_id,
           (row_number() OVER (PARTITION BY k.volume_id ORDER BY k.start_ts DESC, k.seq DESC) = 1) AS is_last
    FROM kept k WHERE k.ok
)
SELECT i.*, lk.volume_id,
       CASE WHEN lk.volume_id IS NOT NULL AND NOT lk.is_last AND i.status0 = 'stopped' THEN 'terminated' ELSE i.status0 END AS status
FROM _i2 i
LEFT JOIN last_kept lk ON lk.seq = i.seq;

INSERT INTO instances (id, user_id, node_id, template_id, volume_id, gpu_model_id, name, pricing_type, gpu_count, container_disk_gb,
                       price_per_hour_snapshot, status, created_at, started_at, stopped_at, terminated_at, last_billed_at)
SELECT md5('gpu-rent-demo-instance-' || i.seq)::uuid, i.user_id, i.node_id, i.template_id, i.volume_id, i.model_id,
       (ARRAY['finetune', 'sd-render', 'jupyter', 'train', 'inference', 'dev-box'])[1 + i.seq % 6] || '-' || i.seq,
       i.pricing_type, i.gpu_count, i.container_disk_gb, i.price_snapshot, i.status::instance_status,
       i.start_ts,
       CASE WHEN i.status <> 'failed' THEN i.start_ts END,
       CASE WHEN i.status IN ('stopped', 'terminated') THEN i.end_ts END,
       CASE WHEN i.status = 'terminated' THEN i.end_ts END,
       CASE WHEN i.status = 'running' THEN p.seed_now WHEN i.status IN ('stopped', 'terminated') THEN i.end_ts END
FROM _i3 i, _p p
ORDER BY i.start_ts, i.seq;

-- Аллокации GPU: running - открытый диапазон, failed - три минуты, остальные - до остановки.
INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during)
SELECT md5('gpu-rent-demo-instance-' || i.seq)::uuid, g.id,
       tstzrange(i.start_ts,
                 CASE i.status WHEN 'running' THEN NULL
                               WHEN 'failed'  THEN i.start_ts + interval '3 minutes'
                               ELSE i.end_ts END, '[)')
FROM _i3 i
JOIN gpus g ON g.node_id = i.node_id AND g.slot_index >= i.first_slot AND g.slot_index < i.first_slot + i.gpu_count
ORDER BY i.start_ts, i.seq, g.slot_index;

-- ============================================================================================
-- 5. Потребление (usage_records): GPU - почасовые записи, хранение - суточные
-- ============================================================================================
-- В бою запись создаётся при обращении пользователя и проходом биллинга (не реже раза в сутки); в сиде GPU
-- агрегированы по часу. Схема и ограничения от этого не меняются.
CREATE TEMP TABLE _usage_raw AS
SELECT i.user_id, md5('gpu-rent-demo-instance-' || i.seq)::uuid AS instance_id, NULL::bigint AS volume_id, 'gpu'::usage_kind AS kind,
       c.ps AS period_start, c.pe AS period_end,
       c.secs AS quantity,
       round(i.price_snapshot * c.secs / 3600, 4) AS amount
FROM _i3 i
CROSS JOIN _p p
CROSS JOIN LATERAL (
    SELECT i.start_ts + k * interval '1 hour' AS ps,
           least(i.start_ts + (k + 1) * interval '1 hour', CASE WHEN i.status = 'running' THEN p.seed_now ELSE i.end_ts END) AS pe,
           extract(epoch FROM least(i.start_ts + (k + 1) * interval '1 hour', CASE WHEN i.status = 'running' THEN p.seed_now ELSE i.end_ts END)
                              - (i.start_ts + k * interval '1 hour')) AS secs
    FROM generate_series(0, ceil(extract(epoch FROM (CASE WHEN i.status = 'running' THEN p.seed_now ELSE i.end_ts END) - i.start_ts) / 3600.0)::int - 1) AS k
) c
WHERE i.status IN ('running', 'stopped', 'terminated');

INSERT INTO _usage_raw
SELECT v.user_id, NULL::uuid, v.id, 'storage'::usage_kind, c.ps, c.pe, v.size_gb * c.secs,
       round(v.size_gb * c.secs * sp.price_per_gb_month / 2592000, 4)
FROM volumes v
CROSS JOIN _p p
CROSS JOIN LATERAL (
    SELECT greatest(v.created_at, p.win_start) AS t_from, v.last_billed_at AS t_to
) r
CROSS JOIN LATERAL (
    SELECT r.t_from + k * interval '1 day' AS ps,
           least(r.t_from + (k + 1) * interval '1 day', r.t_to) AS pe,
           extract(epoch FROM least(r.t_from + (k + 1) * interval '1 day', r.t_to) - (r.t_from + k * interval '1 day')) AS secs
    FROM generate_series(0, ceil(extract(epoch FROM r.t_to - r.t_from) / 86400.0)::int - 1) AS k
) c
JOIN storage_prices sp ON sp.datacenter_id = v.datacenter_id AND sp.valid_during @> c.ps
WHERE r.t_to > r.t_from AND c.secs > 0;

DELETE FROM _usage_raw WHERE amount = 0 OR quantity <= 0;   -- огрызки короче 0,0001 ₽ не записываются, как и в fn_bill_usage

-- Порядок вставки = порядок времени: так BRIN(period_start) в партициях получает хорошую корреляцию.
CREATE TEMP TABLE _usage AS
SELECT row_number() OVER (ORDER BY period_start, kind, instance_id, volume_id)::bigint AS id, r.*
FROM _usage_raw r;

INSERT INTO usage_records (id, user_id, instance_id, volume_id, kind, period_start, period_end, quantity, amount)
OVERRIDING SYSTEM VALUE
SELECT id, user_id, instance_id, volume_id, kind, period_start, period_end, quantity, amount
FROM _usage
ORDER BY id;

-- ============================================================================================
-- 6. Деньги: пополнения и платежи, бонусы, списания
-- ============================================================================================
-- Помесячное пополнение «с запасом» перед первым списанием месяца: баланс в любой момент неотрицателен.
CREATE TEMP TABLE _topup AS
WITH monthly AS (
    SELECT user_id, date_trunc('month', period_end) AS m, sum(amount) AS total, min(period_end) AS first_at
    FROM _usage GROUP BY user_id, date_trunc('month', period_end)
), active AS (
    SELECT mo.user_id,
           (ceil((mo.total * 1.15 + 100) / 100.0) * 100)::numeric(14,2) AS amount,
           greatest(mo.first_at - interval '1 second', u.created_at + interval '1 minute') AS at
    FROM monthly mo JOIN users u ON u.id = mo.user_id
), idle AS (   -- пользователи без потребления: часть из них хотя бы раз пополняла баланс
    SELECT u.id AS user_id, (500 + (u.id % 7) * 250)::numeric(14,2) AS amount, u.created_at + interval '2 days' AS at
    FROM users u, _p p
    WHERE u.id > 2 AND u.id % 3 = 0 AND u.created_at + interval '2 days' < p.seed_now
      AND NOT EXISTS (SELECT 1 FROM _usage x WHERE x.user_id = u.id)
), reserve AS (   -- запас на 3 суток у владельцев работающих инстансов + крупное пополнение demo для показа
    SELECT i.user_id, (ceil(sum(i.price_snapshot) * 72 / 100.0) * 100)::numeric(14,2) AS amount, p.seed_now - interval '30 minutes' AS at
    FROM _i3 i, _p p WHERE i.status = 'running' GROUP BY i.user_id, p.seed_now
    UNION ALL
    SELECT 2, 20000::numeric(14,2), p.seed_now - interval '1 hour' FROM _p p
)
SELECT row_number() OVER (ORDER BY at, user_id, amount)::bigint AS pay_id, user_id, amount, at
FROM (SELECT * FROM active UNION ALL SELECT * FROM idle UNION ALL SELECT * FROM reserve) t;

CREATE TEMP TABLE _pay_extra AS
WITH mx AS (SELECT coalesce(max(pay_id), 0) AS m FROM _topup), src AS (
    -- неудавшиеся платежи: по одному на каждое десятое пополнение, за 10 минут до него
    SELECT t.user_id, t.amount, t.at - interval '10 minutes' AS at, 'failed'::payment_status AS status, t.pay_id AS ord
    FROM _topup t WHERE t.pay_id % 10 = 0
    UNION ALL
    -- платежи, которые шлюз ещё не подтвердил (последний час данных)
    SELECT u.id, 1000, p.seed_now - interval '15 minutes', 'pending'::payment_status, 1000000 + u.id
    FROM users u, _p p WHERE u.id > 2 AND u.id % 25 = 1 AND u.created_at < p.seed_now - interval '1 hour'
)
SELECT mx.m + row_number() OVER (ORDER BY s.at, s.user_id, s.ord) AS pay_id, s.user_id, s.amount, s.at, s.status
FROM src s CROSS JOIN mx;

INSERT INTO payments (id, user_id, provider, provider_payment_id, amount, status, created_at, paid_at)
OVERRIDING SYSTEM VALUE
SELECT pay_id, user_id, 'demo', 'seed-' || md5('pay-' || pay_id), amount, 'succeeded', at - interval '20 seconds', at
FROM _topup
UNION ALL
SELECT pay_id, user_id, 'demo', 'seed-' || md5('pay-' || pay_id), amount, status, at, NULL
FROM _pay_extra
ORDER BY pay_id;

-- Журнал: приветственный бонус, пополнения, списания (created_at списания = конец оплаченного интервала).
INSERT INTO transactions (user_id, type, amount, payment_id, usage_id, usage_period_start, description, created_at)
SELECT user_id, type, amount, payment_id, usage_id, usage_period_start, description, created_at
FROM (
    SELECT u.id AS user_id, 'bonus'::tx_type AS type, 300::numeric(14,4) AS amount, NULL::bigint AS payment_id,
           NULL::bigint AS usage_id, NULL::timestamptz AS usage_period_start,
           'Приветственный бонус' AS description, u.created_at + interval '1 minute' AS created_at, 1 AS ord
    FROM users u WHERE u.id > 2
    UNION ALL
    SELECT t.user_id, 'topup', t.amount, t.pay_id, NULL, NULL, 'Пополнение баланса, платёж ' || t.pay_id, t.at, 2
    FROM _topup t
    UNION ALL
    SELECT x.user_id, 'charge', -x.amount, NULL, x.id, x.period_start,
           CASE x.kind WHEN 'gpu' THEN 'Списание за работу инстанса' ELSE 'Списание за хранение тома' END, x.period_end, 3
    FROM _usage x
) s
ORDER BY created_at, ord, user_id, usage_id;

-- Итоговые балансы = сумма журнала (триггер на время загрузки был отключён).
UPDATE users u SET balance = s.bal
FROM (SELECT user_id, sum(amount) AS bal FROM transactions GROUP BY user_id) s
WHERE s.user_id = u.id;

-- Аудит: блокировки пользователей, выполненные администратором (кроме них в журнале есть вставки цен GPU).
INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip, created_at)
SELECT 1, 'user.status_changed', 'users', u.id::text, '{"from": "active", "to": "blocked"}'::jsonb, '198.51.100.10'::inet,
       least(p.seed_now - interval '1 day', u.created_at + interval '20 days')
FROM users u, _p p WHERE u.status = 'blocked'
ORDER BY u.id;

ALTER TABLE transactions ENABLE TRIGGER trg_transactions_ledger;
ALTER TABLE users        ENABLE TRIGGER trg_users_guard;

-- Идентификаторы вставлялись явно (OVERRIDING SYSTEM VALUE): сдвигаем последовательности за максимум.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname AS tbl, a.attname AS col
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'gpu_rent'::regnamespace AND c.relkind IN ('r', 'p') AND a.attidentity <> '' AND NOT c.relispartition
    LOOP
        EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, %L), greatest(coalesce(max(%I), 0), 1), coalesce(max(%I), 0) > 0) FROM gpu_rent.%I',
                       'gpu_rent.' || r.tbl, r.col, r.col, r.col, r.tbl);
    END LOOP;
END
$$;

-- ============================================================================================
-- 7. Самопроверка: сид обязан быть согласованным, иначе откат
-- ============================================================================================
DO $$
DECLARE
    v_users int; v_inst int; v_usage bigint; v_bad int; v_default bigint; v_nodes int; v_gpus int; v_running int;
BEGIN
    SELECT count(*) INTO v_users FROM users;
    SELECT count(*) INTO v_inst FROM instances;
    SELECT count(*) INTO v_usage FROM usage_records;
    SELECT count(*) INTO v_nodes FROM nodes;
    SELECT count(*) INTO v_gpus FROM gpus;
    SELECT count(*) INTO v_default FROM usage_records_default;
    SELECT count(*) INTO v_running FROM instances WHERE status = 'running';
    IF v_users <> 52 OR v_inst <> 800 OR v_usage NOT BETWEEN 15000 AND 60000 OR v_nodes <> 21 OR v_gpus <> 120 THEN
        RAISE EXCEPTION 'seed volumes are off: users %, instances %, usage %, nodes %, gpus %', v_users, v_inst, v_usage, v_nodes, v_gpus;
    END IF;
    IF v_running < 3 THEN
        RAISE EXCEPTION 'too few running instances: %', v_running;
    END IF;
    IF v_default <> 0 THEN
        RAISE EXCEPTION 'default partition is not empty: % rows', v_default;
    END IF;

    SELECT count(*) INTO v_bad FROM users u
    WHERE u.balance IS DISTINCT FROM coalesce((SELECT sum(t.amount) FROM transactions t WHERE t.user_id = u.id), 0);
    IF v_bad > 0 THEN RAISE EXCEPTION 'balance <> SUM(transactions) for % users', v_bad; END IF;

    SELECT count(*) INTO v_bad FROM transactions t
    JOIN usage_records x ON x.id = t.usage_id AND x.period_start = t.usage_period_start
    WHERE t.type = 'charge' AND (t.amount <> -x.amount OR t.user_id <> x.user_id);
    IF v_bad > 0 THEN RAISE EXCEPTION '% charges do not match their usage records', v_bad; END IF;
    SELECT count(*) INTO v_bad FROM usage_records x
    WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.usage_id = x.id AND t.usage_period_start = x.period_start AND t.type = 'charge');
    IF v_bad > 0 THEN RAISE EXCEPTION '% usage records without a charge', v_bad; END IF;

    SELECT count(*) INTO v_bad FROM users WHERE balance < 0;
    IF v_bad > 0 THEN RAISE EXCEPTION '% users have a negative balance', v_bad; END IF;

    -- у каждого running-инстанса открыто ровно gpu_count аллокаций, у остальных - ни одной
    SELECT count(*) INTO v_bad FROM instances i
    WHERE (SELECT count(*) FROM instance_gpus ig WHERE ig.instance_id = i.id AND upper_inf(ig.allocated_during))
          <> CASE WHEN i.status = 'running' THEN i.gpu_count ELSE 0 END;
    IF v_bad > 0 THEN RAISE EXCEPTION '% instances have a wrong number of open allocations', v_bad; END IF;

    RAISE NOTICE 'demo seed ok: % users, % nodes, % gpus, % instances (% running), % usage records',
        v_users, v_nodes, v_gpus, v_inst, v_running, v_usage;
END
$$;

COMMIT;

-- Только таблицы схемы: голый ANALYZE задевает и системные каталоги, а без суперпользователя (Neon) это даёт
-- «permission denied to analyze» по каждому из них
DO $$
DECLARE
    t regclass;
BEGIN
    FOR t IN SELECT c.oid::regclass FROM pg_class c
             WHERE c.relnamespace = 'gpu_rent'::regnamespace AND c.relkind IN ('r', 'p', 'm') AND NOT c.relispartition
    LOOP
        EXECUTE format('ANALYZE %s', t);
    END LOOP;
END
$$;
REFRESH MATERIALIZED VIEW mv_daily_revenue;

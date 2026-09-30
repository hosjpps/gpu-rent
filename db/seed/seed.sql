-- Детерминированные тестовые данные GPU Rent: 4 ДЦ, 6 моделей GPU, 60 нод, ~390 GPU, 5 000 пользователей,
-- 20 000 инстансов, >= 1 млн записей usage_records за 12 месяцев (2025-10 .. 2026-09) и согласованный журнал операций.
--
-- Принципы:
--   * детерминизм: setseed + порядок строк задан ORDER BY; два прогона дают одинаковые данные (кроме шифртекста env): значения created_at заданы явно, а не по now();
--   * "сейчас" в данных фиксировано (seed_now), а не now(): результат не зависит от даты запуска;
--   * для скорости триггер баланса и его защита отключены на время загрузки, итоговые балансы
--     считаются одним UPDATE из журнала и сверяются в конце (раздел "Самопроверка").
-- Запуск: сразу после миграций, суперпользователем (db/scripts/reset.sh).
\set ON_ERROR_STOP on
\set seed_now  '2026-09-30 12:00:00+00'
\set win_start '2025-10-01 00:00:00+00'
\set user_t0   '2025-08-15 00:00:00+00'

BEGIN;
SET LOCAL timezone = 'UTC';
SET LOCAL synchronous_commit = off;
SET LOCAL work_mem = '256MB';
SET LOCAL max_parallel_workers_per_gather = 0;   -- random() в параллельных воркерах давал бы недетерминированный порядок
SELECT setseed(0.4242) \g /dev/null
-- Демонстрационный ключ шифрования env-переменных. В эксплуатации ключ задаёт приложение, в репозитории его нет.
SELECT set_config('app.enc_key', 'seed-demo-key-not-a-secret', true) \g /dev/null

ALTER TABLE transactions DISABLE TRIGGER trg_transactions_ledger;
ALTER TABLE users        DISABLE TRIGGER trg_users_guard;

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

-- План инфраструктуры: сколько нод какой модели в каком ДЦ и сколько GPU в ноде.
CREATE TEMP TABLE _plan (dc text, model text, slug text, nodes int, gpus_per int);
INSERT INTO _plan VALUES
    ('MSK-1', 'RTX 3090',  '3090', 3, 4), ('MSK-1', 'RTX 4090',  '4090', 5, 8), ('MSK-1', 'RTX A6000', 'a6000', 2, 4),
    ('MSK-1', 'L40S',      'l40s', 3, 8), ('MSK-1', 'A100 80GB', 'a100', 5, 8), ('MSK-1', 'H100 80GB', 'h100', 4, 8),
    ('SPB-1', 'RTX 3090',  '3090', 3, 4), ('SPB-1', 'RTX 4090',  '4090', 4, 8), ('SPB-1', 'RTX A6000', 'a6000', 3, 4),
    ('SPB-1', 'L40S',      'l40s', 2, 4), ('SPB-1', 'A100 80GB', 'a100', 4, 8),
    ('NSK-1', 'RTX 3090',  '3090', 3, 4), ('NSK-1', 'RTX 4090',  '4090', 4, 8), ('NSK-1', 'L40S',      'l40s', 3, 4),
    ('KZN-1', 'RTX 4090',  '4090', 4, 8), ('KZN-1', 'A100 80GB', 'a100', 3, 8), ('KZN-1', 'H100 80GB', 'h100', 2, 8),
    ('KZN-1', 'RTX A6000', 'a6000', 3, 4);

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
       timestamptz '2025-06-01 09:00:00+00' + ord * interval '1 day'
FROM _node_src ORDER BY ord;

-- Пара нод на обслуживании/выключена: в каталоге они не дают свободных GPU.
UPDATE nodes SET status = 'maintenance' WHERE hostname IN ('msk1-h100-04', 'spb1-a100-04');
UPDATE nodes SET status = 'offline'     WHERE hostname = 'nsk1-l40s-03';

INSERT INTO gpus (node_id, gpu_model_id, slot_index, serial, is_enabled)
SELECT n.id, s.model_id, slot, 'SN' || upper(substr(md5('gpu-' || n.id || '-' || slot), 1, 12)),
       (n.id * 8 + slot) % 97 <> 0          -- около 1 % GPU выведено из эксплуатации
FROM _node_src s
JOIN nodes n ON n.hostname = s.hostname
CROSS JOIN LATERAL generate_series(0, s.gpus_per - 1) AS slot
ORDER BY n.id, slot;

-- История цен: четыре периода, цена растёт; ДЦ вносят региональный коэффициент; спот на 44-48 % дешевле.
CREATE TEMP TABLE _base_price (model text, od numeric);
INSERT INTO _base_price VALUES ('RTX 3090', 48), ('RTX 4090', 75), ('RTX A6000', 95), ('L40S', 140), ('A100 80GB', 285), ('H100 80GB', 520);
CREATE TEMP TABLE _dc_factor (dc text, f numeric);
INSERT INTO _dc_factor VALUES ('MSK-1', 1.00), ('SPB-1', 0.97), ('NSK-1', 0.92), ('KZN-1', 0.95);
CREATE TEMP TABLE _period (n int, from_ts timestamptz, to_ts timestamptz, pf numeric, spot_ratio numeric);
INSERT INTO _period VALUES
    (1, '2025-09-01 00:00:00+00', '2026-01-01 00:00:00+00', 1.00, 0.55),
    (2, '2026-01-01 00:00:00+00', '2026-04-01 00:00:00+00', 1.06, 0.52),
    (3, '2026-04-01 00:00:00+00', '2026-07-01 00:00:00+00', 1.03, 0.56),
    (4, '2026-07-01 00:00:00+00', NULL,                     1.08, 0.52);

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

-- Триггер аудита записал в журнал вставки цен со временем загрузки (now()); относим их к началу действия цены,
-- иначе данные зависят от даты запуска. Запрет правки журнала снимается только на этот UPDATE.
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
-- 2. Пользователи (id = порядковый номер; 1 - администратор, 2 - демо-клиент)
-- ============================================================================================
-- Пользователи регистрируются равномерно-ускоренно с 2025-08-15 по 2026-09-25: id растёт вместе с датой регистрации.
-- Учётные записи 1 и 2 имеют настоящие bcrypt-хэши (пароли admin12345 / demo12345, соль фиксирована ради
-- детерминизма); у остальных хэш правдоподобен по формату, но войти под ними нельзя.
INSERT INTO users (id, email, password_hash, full_name, role, status, email_verified_at, created_at, updated_at)
OVERRIDING SYSTEM VALUE
SELECT u.n,
       CASE u.n WHEN 1 THEN 'admin@gpu-rent.example'
                WHEN 2 THEN 'demo@gpu-rent.example'
                WHEN 3 THEN 'ops1@gpu-rent.example' WHEN 4 THEN 'ops2@gpu-rent.example' WHEN 5 THEN 'ops3@gpu-rent.example'
                ELSE 'user' || lpad(u.n::text, 4, '0') || '@example.com' END,
       CASE u.n WHEN 1 THEN crypt('admin12345', '$2a$10$abcdefghijklmnopqrstuu')
                WHEN 2 THEN crypt('demo12345',  '$2a$10$abcdefghijklmnopqrstuu')
                ELSE '$2b$12$' || substr(translate(encode(digest(u.n || 'x', 'sha256'), 'base64')
                                                   || encode(digest(u.n || 'y', 'sha256'), 'base64'), '+=' || E'\n', '.AA'), 1, 53) END,
       CASE u.n WHEN 1 THEN 'Администратор Системы'
                WHEN 2 THEN 'Демонстрационный Клиент'
                WHEN 3 THEN 'Дежурный Инженер Первый' WHEN 4 THEN 'Дежурный Инженер Второй' WHEN 5 THEN 'Дежурный Инженер Третий'
                ELSE CASE WHEN u.n % 2 = 0
                          THEN (ARRAY['Иванов','Петров','Сидоров','Смирнов','Кузнецов','Попов','Васильев','Соколов','Михайлов','Новиков',
                                      'Фёдоров','Морозов','Волков','Алексеев','Лебедев','Семёнов','Егоров','Павлов','Козлов','Степанов',
                                      'Николаев','Орлов','Андреев','Макаров','Никитин','Захаров','Зайцев','Соловьёв','Борисов','Яковлев'])[1 + (u.n * 31 + 7) % 30]
                               || ' ' || (ARRAY['Александр','Дмитрий','Максим','Сергей','Андрей','Алексей','Артём','Илья','Кирилл','Михаил',
                                                'Никита','Матвей','Роман','Егор','Арсений','Иван','Денис','Евгений','Даниил','Тимофей'])[1 + (u.n * 17 + 3) % 20]
                               || ' ' || (ARRAY['Александрович','Дмитриевич','Сергеевич','Андреевич','Алексеевич','Иванович','Михайлович','Николаевич',
                                                'Владимирович','Павлович','Петрович','Олегович','Игоревич','Викторович','Юрьевич','Анатольевич',
                                                'Денисович','Романович','Евгеньевич','Максимович'])[1 + (u.n * 13 + 5) % 20]
                          ELSE (ARRAY['Иванов','Петров','Сидоров','Смирнов','Кузнецов','Попов','Васильев','Соколов','Михайлов','Новиков',
                                      'Фёдоров','Морозов','Волков','Алексеев','Лебедев','Семёнов','Егоров','Павлов','Козлов','Степанов',
                                      'Николаев','Орлов','Андреев','Макаров','Никитин','Захаров','Зайцев','Соловьёв','Борисов','Яковлев'])[1 + (u.n * 31 + 7) % 30] || 'а'
                               || ' ' || (ARRAY['Анна','Мария','Елена','Ольга','Наталья','Екатерина','Татьяна','Ирина','Светлана','Юлия',
                                                'Анастасия','Дарья','Полина','Виктория','Алиса','Ксения','Софья','Александра','Марина','Вера'])[1 + (u.n * 17 + 3) % 20]
                               || ' ' || (ARRAY['Александровна','Дмитриевна','Сергеевна','Андреевна','Алексеевна','Ивановна','Михайловна','Николаевна',
                                                'Владимировна','Павловна','Петровна','Олеговна','Игоревна','Викторовна','Юрьевна','Анатольевна',
                                                'Денисовна','Романовна','Евгеньевна','Максимовна'])[1 + (u.n * 13 + 5) % 20]
                     END END,
       CASE WHEN u.n IN (1, 3, 4, 5) THEN 'admin'::user_role ELSE 'client'::user_role END,
       CASE WHEN u.n > 5 AND u.n % 97 = 0 THEN 'blocked'::user_status ELSE 'active'::user_status END,
       CASE WHEN u.n % 17 <> 0 THEN u.created_at + (u.n % 120) * interval '1 minute' END,
       u.created_at,
       u.created_at
FROM (SELECT n, date_trunc('second', :'user_t0'::timestamptz + 35078400 * power(n / 5000.0, 0.85) * interval '1 second') AS created_at
      FROM generate_series(1, 5000) AS n) u
ORDER BY u.n;

-- SSH- и API-ключи
INSERT INTO ssh_keys (user_id, name, public_key, fingerprint, created_at)
SELECT u.id,
       (ARRAY['laptop','work-pc','ci-runner','home','cloud-shell'])[1 + k % 5],
       'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI' || substr(encode(digest('ssh' || k, 'sha256'), 'base64'), 1, 43) || ' user@host',
       'SHA256:' || replace(encode(digest('fp' || k, 'sha256'), 'base64'), '=', ''),
       u.created_at + interval '1 day'
FROM generate_series(1, 3000) k
JOIN users u ON u.id = 6 + (k * 13) % 4990
ORDER BY k;

INSERT INTO api_keys (user_id, name, key_prefix, key_hash, last_used_at, expires_at, revoked_at, created_at)
SELECT u.id, (ARRAY['ci','notebook','backend','cli'])[1 + k % 4],
       'gr_' || substr(md5('p' || k), 1, 5),
       digest('api-key-' || k, 'sha256'),
       CASE WHEN k % 5 <> 0 THEN least(:'seed_now'::timestamptz, u.created_at + interval '1 day' * (k % 200 + 2)) END,
       CASE WHEN k % 2 = 0 THEN u.created_at + interval '1 day' + interval '365 days' END,
       CASE WHEN k % 10 = 0 THEN least(:'seed_now'::timestamptz, u.created_at + interval '1 day' * (k % 150 + 3)) END,
       u.created_at + interval '1 day'
FROM generate_series(1, 1500) k
JOIN users u ON u.id = 6 + (k * 29) % 4990
ORDER BY k;

-- ============================================================================================
-- 3. Шаблоны и тома
-- ============================================================================================
INSERT INTO templates (id, owner_id, name, docker_image, default_disk_gb, default_ports, is_public, created_at)
OVERRIDING SYSTEM VALUE VALUES
    (1, NULL, 'PyTorch 2.4 (CUDA 12.4)',       'pytorch/pytorch:2.4.0-cuda12.4-cudnn9-devel',       50,  '22/tcp,8888/http', true, :'user_t0'::timestamptz),
    (2, NULL, 'JupyterLab + PyTorch',          'quay.io/jupyter/pytorch-notebook:cuda12-latest',    40,  '8888/http',        true, :'user_t0'::timestamptz),
    (3, NULL, 'Stable Diffusion WebUI',        'ghcr.io/ai-dock/stable-diffusion-webui:latest',     80,  '7860/http',        true, :'user_t0'::timestamptz),
    (4, NULL, 'ComfyUI',                       'ghcr.io/ai-dock/comfyui:latest',                    80,  '8188/http',        true, :'user_t0'::timestamptz),
    (5, NULL, 'TensorFlow 2.16 GPU + Jupyter', 'tensorflow/tensorflow:2.16.1-gpu-jupyter',          50,  '8888/http',        true, :'user_t0'::timestamptz),
    (6, NULL, 'Text Generation Inference',      'ghcr.io/huggingface/text-generation-inference:latest', 100, '8080/http',     true, :'user_t0'::timestamptz),
    (7, NULL, 'Ollama',                        'ollama/ollama:latest',                              100, '11434/http',       true, :'user_t0'::timestamptz),
    (8, NULL, 'CUDA 12.4 devel (Ubuntu 22.04)', 'nvidia/cuda:12.4.1-devel-ubuntu22.04',            30,  '22/tcp',           true, :'user_t0'::timestamptz);

SELECT setval(pg_get_serial_sequence('templates', 'id'), 8) \g /dev/null

INSERT INTO templates (owner_id, name, docker_image, default_disk_gb, default_ports, is_public, created_at)
SELECT u.id, 'my-env-' || u.id, 'registry.example.com/team' || u.id || '/env:latest', 60, '22/tcp', false, u.created_at + interval '3 days'
FROM users u WHERE u.id > 5 AND u.id % 40 = 0
ORDER BY u.id;

-- Сетевые тома: не больше одного тома на пару (пользователь, ДЦ). Создаются не раньше начала окна данных.
CREATE TEMP TABLE _vol AS
SELECT row_number() OVER (ORDER BY u.id, v.slot)::int AS vid, u.id AS user_id, v.dc_no, v.slot,
       (ARRAY[50, 100, 200, 500, 1000, 2000])[1 + (u.id + v.slot) % 6] AS size_gb,
       least(:'seed_now'::timestamptz - interval '1 day',
             greatest(u.created_at + (u.id % 500) * interval '1 hour', :'win_start'::timestamptz + (u.id % 60) * interval '1 hour')) AS created_at,
       (u.id % 13 = 0 AND v.slot = 1) AS will_delete
FROM users u
CROSS JOIN LATERAL (VALUES (1, 1 + u.id % 4), (2, 1 + (u.id + 1) % 4)) AS v(slot, dc_no)
WHERE u.id > 5 AND ((v.slot = 1 AND u.id % 3 = 0) OR (v.slot = 2 AND u.id % 9 = 0));

INSERT INTO volumes (id, user_id, datacenter_id, name, size_gb, status, created_at, deleted_at, last_billed_at)
OVERRIDING SYSTEM VALUE
SELECT v.vid, v.user_id, v.dc_no, 'data-' || v.vid, v.size_gb,
       CASE WHEN v.will_delete THEN 'deleted'::volume_status ELSE 'active'::volume_status END,
       v.created_at,
       CASE WHEN v.will_delete THEN least(:'seed_now'::timestamptz - interval '12 hours', v.created_at + (20 + v.vid % 150) * interval '1 day') END,
       CASE WHEN v.will_delete THEN least(:'seed_now'::timestamptz - interval '12 hours', v.created_at + (20 + v.vid % 150) * interval '1 day')
            ELSE :'seed_now'::timestamptz END
FROM _vol v
ORDER BY v.vid;

-- ============================================================================================
-- 4. Инстансы: на каждой "линии" (группе GPU одной ноды) задания идут друг за другом без наложений
-- ============================================================================================
-- Линия = lane_size соседних GPU одной ноды (размер зависит от ноды: 1, 2, 4 или 8).
-- Аллокации внутри линии по построению не пересекаются, поэтому EXCLUDE на instance_gpus
-- принимает сид без конфликтов. Число заданий на линию ограничено окном данных.
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
    FROM _lane l CROSS JOIN generate_series(1, 220) AS n
), cum AS (
    SELECT lane_id, n, dur_h,
           sum(gap_h + dur_h) OVER (PARTITION BY lane_id ORDER BY n) - dur_h AS start_off_h
    FROM raw
)
SELECT lane_id, n,
       date_trunc('second', :'win_start'::timestamptz + start_off_h * interval '1 hour')           AS start_ts,
       date_trunc('second', :'win_start'::timestamptz + (start_off_h + dur_h) * interval '1 hour') AS plan_end_ts
FROM cum
WHERE :'win_start'::timestamptz + start_off_h * interval '1 hour' < :'seed_now'::timestamptz;

-- Ровно 20 000 заданий: из кандидатов остаются первые по хэшу (детерминированная "случайная" выборка).
CREATE TEMP TABLE _sel AS
SELECT row_number() OVER (ORDER BY j.start_ts, j.lane_id)::int AS seq,
       j.lane_id, j.start_ts, j.plan_end_ts,
       l.node_id, l.datacenter_id, l.node_status, l.model_id, l.lane_size AS gpu_count, l.first_slot
FROM (SELECT j.*, row_number() OVER (ORDER BY md5(j.lane_id::text || ':' || j.n::text)) AS pick FROM _job_raw j) j
JOIN _lane l ON l.lane_id = j.lane_id
WHERE j.pick <= 20000;

-- Владелец, тариф, шаблон, диск, предварительный статус. Владельцы берутся среди уже зарегистрированных к началу задания,
-- старые пользователи встречаются чаще (степенной закон), как у реального сервиса.
CREATE TEMP TABLE _i1 AS
WITH rnd AS (
    SELECT s.*, random() AS r_user, random() AS r_type, random() AS r_tpl, random() AS r_disk, random() AS r_stat, random() AS r_vol
    FROM _sel s
), usr AS (
    SELECT r.*,
           least(5000, greatest(60, floor(5000 * power(extract(epoch FROM r.start_ts - :'user_t0'::timestamptz) / 35078400.0, 1 / 0.85))::int)) AS nvis
    FROM rnd r
)
SELECT u.seq, u.lane_id, u.node_id, u.datacenter_id, u.node_status, u.model_id, u.gpu_count, u.first_slot, u.start_ts, u.plan_end_ts,
       CASE WHEN u.seq % 350 = 0 THEN 2 ELSE 6 + floor((u.nvis - 5) * power(u.r_user, 1.6))::int END AS user_id,
       CASE WHEN u.r_type < 0.25 THEN 'spot'::pricing_type ELSE 'on_demand'::pricing_type END AS pricing_type,
       1 + floor(u.r_tpl * 8)::int AS template_id,
       (ARRAY[30, 50, 100, 200])[1 + floor(u.r_disk * 4)::int] AS container_disk_gb,
       u.r_stat, u.r_vol,
       (u.plan_end_ts > :'seed_now'::timestamptz) AS crosses_now
FROM usr u;

-- Снимок цены = цена GPU на момент старта * число GPU; предварительный статус и фактический конец.
CREATE TEMP TABLE _i2 AS
SELECT i.*,
       round(gp.price_per_hour * i.gpu_count, 4) AS price_snapshot,
       CASE WHEN i.crosses_now THEN :'seed_now'::timestamptz ELSE i.plan_end_ts END AS end_ts,
       CASE WHEN i.crosses_now THEN (CASE WHEN i.node_status = 'online' AND us.status = 'active' THEN 'running' ELSE 'stopped' END)
            WHEN i.r_stat < 0.02 THEN 'failed'
            WHEN i.r_stat < 0.12 THEN 'stopped'
            ELSE 'terminated' END AS status0
FROM _i1 i
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
SELECT md5('gpu-rent-instance-' || i.seq)::uuid, i.user_id, i.node_id, i.template_id, i.volume_id, i.model_id,
       (ARRAY['finetune', 'sd-render', 'jupyter', 'train', 'inference', 'dev-box'])[1 + i.seq % 6] || '-' || i.seq,
       i.pricing_type, i.gpu_count, i.container_disk_gb, i.price_snapshot, i.status::instance_status,
       i.start_ts,
       CASE WHEN i.status <> 'failed' THEN i.start_ts END,
       CASE WHEN i.status IN ('stopped', 'terminated') THEN i.end_ts END,
       CASE WHEN i.status = 'terminated' THEN i.end_ts END,
       CASE WHEN i.status = 'running' THEN :'seed_now'::timestamptz WHEN i.status IN ('stopped', 'terminated') THEN i.end_ts END
FROM _i3 i
ORDER BY i.start_ts, i.seq;

-- Аллокации GPU: running - открытый диапазон, failed - три минуты, остальные - до остановки.
INSERT INTO instance_gpus (instance_id, gpu_id, allocated_during)
SELECT md5('gpu-rent-instance-' || i.seq)::uuid, g.id,
       tstzrange(i.start_ts,
                 CASE i.status WHEN 'running' THEN NULL
                               WHEN 'failed'  THEN i.start_ts + interval '3 minutes'
                               ELSE i.end_ts END, '[)')
FROM _i3 i
JOIN gpus g ON g.node_id = i.node_id AND g.slot_index >= i.first_slot AND g.slot_index < i.first_slot + i.gpu_count
ORDER BY i.start_ts, i.seq, g.slot_index;

-- Секреты env (шифруются демонстрационным ключом): у работающих инстансов и у каждого сороковского.
INSERT INTO instance_env_vars (instance_id, name, value_encrypted)
SELECT md5('gpu-rent-instance-' || i.seq)::uuid, v.name, pgp_sym_encrypt(v.val || substr(md5(i.seq || v.name), 1, 24), current_setting('app.enc_key'))
FROM _i3 i
CROSS JOIN (VALUES ('HF_TOKEN', 'hf_'), ('WANDB_API_KEY', 'wandb_')) AS v(name, val)
WHERE i.status = 'running' OR i.seq % 40 = 0;

-- ============================================================================================
-- 5. Потребление (usage_records): GPU - почасовые записи, хранение - суточные
-- ============================================================================================
-- В бою проход биллинга пишет запись раз в минуту; в сиде GPU агрегированы по часу, иначе объём
-- вышел бы за десятки миллионов строк. Схема и ограничения от этого не меняются.
CREATE TEMP TABLE _usage_raw AS
SELECT i.user_id, md5('gpu-rent-instance-' || i.seq)::uuid AS instance_id, NULL::bigint AS volume_id, 'gpu'::usage_kind AS kind,
       c.ps AS period_start, c.pe AS period_end,
       c.secs AS quantity,
       round(i.price_snapshot * c.secs / 3600, 4) AS amount
FROM _i3 i
CROSS JOIN LATERAL (
    SELECT i.start_ts + k * interval '1 hour' AS ps,
           least(i.start_ts + (k + 1) * interval '1 hour', CASE WHEN i.status = 'running' THEN :'seed_now'::timestamptz ELSE i.end_ts END) AS pe,
           extract(epoch FROM least(i.start_ts + (k + 1) * interval '1 hour', CASE WHEN i.status = 'running' THEN :'seed_now'::timestamptz ELSE i.end_ts END)
                              - (i.start_ts + k * interval '1 hour')) AS secs
    FROM generate_series(0, ceil(extract(epoch FROM (CASE WHEN i.status = 'running' THEN :'seed_now'::timestamptz ELSE i.end_ts END) - i.start_ts) / 3600.0)::int - 1) AS k
) c
WHERE i.status IN ('running', 'stopped', 'terminated');

INSERT INTO _usage_raw
SELECT v.user_id, NULL::uuid, v.id, 'storage'::usage_kind, c.ps, c.pe, v.size_gb * c.secs,
       round(v.size_gb * c.secs * sp.price_per_gb_month / 2592000, 4)
FROM volumes v
CROSS JOIN LATERAL (
    SELECT greatest(v.created_at, :'win_start'::timestamptz) AS t_from, v.last_billed_at AS t_to
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

-- Массовая загрузка двух крупнейших таблиц: внешние ключи и вторичные индексы на время вставки снимаются
-- и создаются заново в конце. Так PostgreSQL проверяет ссылочную целостность одним соединением вместо
-- миллиона точечных проверок, а индексы строит за один проход. Определения берутся из каталога, а не
-- дублируются здесь, поэтому сид не расходится с миграциями.
CREATE TEMP TABLE _saved_ddl (ord serial, kind text, tbl regclass, name text, def text);
INSERT INTO _saved_ddl (kind, tbl, name, def)
SELECT 'index', i.indrelid::regclass, c.relname, pg_get_indexdef(i.indexrelid)
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid IN ('gpu_rent.transactions'::regclass, 'gpu_rent.usage_records'::regclass)
  AND NOT c.relispartition
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)
ORDER BY c.relname;
INSERT INTO _saved_ddl (kind, tbl, name, def)
SELECT 'fk', conrelid::regclass, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'f' AND conparentid = 0
  AND conrelid IN ('gpu_rent.transactions'::regclass, 'gpu_rent.usage_records'::regclass)
ORDER BY conname;

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT * FROM _saved_ddl WHERE kind = 'fk' ORDER BY ord LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.name);
    END LOOP;
    FOR r IN SELECT * FROM _saved_ddl WHERE kind = 'index' ORDER BY ord LOOP
        EXECUTE format('DROP INDEX gpu_rent.%I', r.name);
    END LOOP;
END
$$;

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
-- Помесячное пополнение "с запасом" перед первым списанием месяца: баланс в любой момент неотрицателен.
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
    FROM users u
    WHERE u.id > 5 AND u.id % 3 = 0 AND u.created_at + interval '2 days' < :'seed_now'::timestamptz
      AND NOT EXISTS (SELECT 1 FROM _usage x WHERE x.user_id = u.id)
)
SELECT row_number() OVER (ORDER BY at, user_id)::bigint AS pay_id, user_id, amount, at
FROM (SELECT * FROM active UNION ALL SELECT * FROM idle) t;

CREATE TEMP TABLE _pay_extra AS
WITH mx AS (SELECT coalesce(max(pay_id), 0) AS m FROM _topup), src AS (
    -- неудавшиеся платежи: по одному на каждое пятидесятое пополнение, за 10 минут до него
    SELECT t.user_id, t.amount, t.at - interval '10 minutes' AS at, 'failed'::payment_status AS status, t.pay_id AS ord
    FROM _topup t WHERE t.pay_id % 50 = 0
    UNION ALL
    -- платежи, которые шлюз ещё не подтвердил (последний час данных)
    SELECT u.id, 1000, :'seed_now'::timestamptz - interval '15 minutes', 'pending'::payment_status, 1000000 + u.id
    FROM users u WHERE u.id > 5 AND u.id % 500 = 1 AND u.created_at < :'seed_now'::timestamptz - interval '1 hour'
)
SELECT mx.m + row_number() OVER (ORDER BY s.at, s.user_id, s.ord) AS pay_id, s.user_id, s.amount, s.at, s.status
FROM src s CROSS JOIN mx;

INSERT INTO payments (id, user_id, provider, provider_payment_id, amount, status, created_at, paid_at)
OVERRIDING SYSTEM VALUE
SELECT pay_id, user_id, 'yookassa', md5('yk-' || pay_id)::uuid::text, amount, 'succeeded', at - interval '20 seconds', at
FROM _topup
UNION ALL
SELECT pay_id, user_id, 'yookassa', md5('yk-' || pay_id)::uuid::text, amount, status, at, NULL
FROM _pay_extra
ORDER BY pay_id;

-- Журнал: приветственный бонус, пополнения, списания (created_at списания = конец оплаченного интервала).
INSERT INTO transactions (user_id, type, amount, payment_id, usage_id, usage_period_start, description, created_at)
SELECT user_id, type, amount, payment_id, usage_id, usage_period_start, description, created_at
FROM (
    SELECT u.id AS user_id, 'bonus'::tx_type AS type, 300::numeric(14,4) AS amount, NULL::bigint AS payment_id,
           NULL::bigint AS usage_id, NULL::timestamptz AS usage_period_start,
           'Приветственный бонус' AS description, u.created_at + interval '1 minute' AS created_at, 1 AS ord
    FROM users u WHERE u.id > 5
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

-- Аудит: блокировки пользователей, выполненные администратором. Кроме них в журнале есть вставки цен GPU,
-- записанные триггером при загрузке цен (раздел 1; время перенесено на начало действия цены).
INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, ip, created_at)
SELECT 1, 'user.status_changed', 'users', u.id::text, '{"from": "active", "to": "blocked"}'::jsonb, '198.51.100.10'::inet,
       least(:'seed_now'::timestamptz - interval '1 day', u.created_at + interval '20 days')
FROM users u WHERE u.status = 'blocked'
ORDER BY u.id;

-- Возвращаем снятые индексы и внешние ключи; ADD CONSTRAINT проверяет все загруженные строки.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT * FROM _saved_ddl WHERE kind = 'index' ORDER BY ord LOOP
        -- для партиционированной таблицы pg_get_indexdef отдаёт "ON ONLY": без снятия ONLY индекс остался бы
        -- на одном родителе (помеченным недействительным) и не попал бы в партиции
        EXECUTE replace(r.def, ' ON ONLY ', ' ON ');
    END LOOP;
    FOR r IN SELECT * FROM _saved_ddl WHERE kind = 'fk' ORDER BY ord LOOP
        EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.name, r.def);
    END LOOP;
END
$$;

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
    v_users int; v_inst int; v_usage bigint; v_bad int; v_default bigint; v_nodes int; v_gpus int;
BEGIN
    SELECT count(*) INTO v_users FROM users;
    SELECT count(*) INTO v_inst FROM instances;
    SELECT count(*) INTO v_usage FROM usage_records;
    SELECT count(*) INTO v_nodes FROM nodes;
    SELECT count(*) INTO v_gpus FROM gpus;
    SELECT count(*) INTO v_default FROM usage_records_default;
    IF v_users <> 5000 OR v_inst <> 20000 OR v_usage < 1000000 OR v_nodes <> 60 THEN
        RAISE EXCEPTION 'seed volumes are off: users %, instances %, usage %, nodes %', v_users, v_inst, v_usage, v_nodes;
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

    RAISE NOTICE 'seed ok: % users, % nodes, % gpus, % instances, % usage records', v_users, v_nodes, v_gpus, v_inst, v_usage;
END
$$;

COMMIT;

ANALYZE;
REFRESH MATERIALIZED VIEW mv_daily_revenue;

-- Фикстура для тестов: своя изолированная инфраструктура (ДЦ TST-1/TST-2), чтобы тесты не зависели от сида.
-- Выполняется суперпользователем внутри транзакции теста; всё откатывается вместе с ней.
-- Состав:
--   TST-1: нода n1 (4 GPU модели A), нода n2 (2 GPU модели A); цены A: on_demand 100, spot 50 ₽/ч; тариф хранения 18 ₽/ГБ·мес
--   TST-2: нода n3 (2 GPU модели A), цена A 100 ₽/ч
--   пользователи: u1, u2 (по 10 000 ₽), u3 (0 ₽), adm (администратор); публичный шаблон tpl
--   тома: vol1 (u1, TST-1, 100 ГБ), vol2 (u1, TST-2, 100 ГБ)
DO $$
DECLARE
    v_dc1 bigint; v_dc2 bigint; v_ma bigint; v_mb bigint; v_n1 bigint; v_n2 bigint; v_n3 bigint;
    v_u1 bigint;  v_u2 bigint;  v_u3 bigint;  v_adm bigint; v_tpl bigint; v_pay bigint;
    v_uid bigint; v_n int := 0; v_vol1 bigint; v_vol2 bigint;
BEGIN
    INSERT INTO datacenters (code, name, city, country) VALUES ('TST-1', 'Тест 1', 'Москва', 'RU') RETURNING id INTO v_dc1;
    INSERT INTO datacenters (code, name, city, country) VALUES ('TST-2', 'Тест 2', 'Казань', 'RU') RETURNING id INTO v_dc2;
    INSERT INTO gpu_models (vendor, name, vram_gb, fp32_tflops) VALUES ('NVIDIA', 'TST-A', 24, 80) RETURNING id INTO v_ma;
    INSERT INTO gpu_models (vendor, name, vram_gb, fp32_tflops) VALUES ('NVIDIA', 'TST-B', 80, 60) RETURNING id INTO v_mb;

    INSERT INTO nodes (datacenter_id, hostname, cpu_cores, ram_gb, disk_gb) VALUES (v_dc1, 'tst-n1', 32, 256, 2000) RETURNING id INTO v_n1;
    INSERT INTO nodes (datacenter_id, hostname, cpu_cores, ram_gb, disk_gb) VALUES (v_dc1, 'tst-n2', 32, 256, 2000) RETURNING id INTO v_n2;
    INSERT INTO nodes (datacenter_id, hostname, cpu_cores, ram_gb, disk_gb) VALUES (v_dc2, 'tst-n3', 32, 256, 2000) RETURNING id INTO v_n3;
    INSERT INTO gpus (node_id, gpu_model_id, slot_index, serial) SELECT v_n1, v_ma, s, 'tst-n1-' || s FROM generate_series(0, 3) s;
    INSERT INTO gpus (node_id, gpu_model_id, slot_index, serial) SELECT v_n2, v_ma, s, 'tst-n2-' || s FROM generate_series(0, 1) s;
    INSERT INTO gpus (node_id, gpu_model_id, slot_index, serial) SELECT v_n3, v_ma, s, 'tst-n3-' || s FROM generate_series(0, 1) s;

    INSERT INTO gpu_prices (datacenter_id, gpu_model_id, pricing_type, price_per_hour, valid_during) VALUES
        (v_dc1, v_ma, 'on_demand', 100, tstzrange(now() - interval '30 days', NULL, '[)')),
        (v_dc1, v_ma, 'spot',       50, tstzrange(now() - interval '30 days', NULL, '[)')),
        (v_dc2, v_ma, 'on_demand', 100, tstzrange(now() - interval '30 days', NULL, '[)'));
    INSERT INTO storage_prices (datacenter_id, price_per_gb_month, valid_during) VALUES
        (v_dc1, 18, tstzrange(now() - interval '30 days', NULL, '[)')),
        (v_dc2, 18, tstzrange(now() - interval '30 days', NULL, '[)'));

    INSERT INTO users (email, password_hash, full_name) VALUES ('tst-u1@example.test', '$2b$12$' || repeat('a', 53), 'Иванов Иван Иванович') RETURNING id INTO v_u1;
    INSERT INTO users (email, password_hash, full_name) VALUES ('tst-u2@example.test', '$2b$12$' || repeat('b', 53), 'Петров Пётр Петрович') RETURNING id INTO v_u2;
    INSERT INTO users (email, password_hash, full_name) VALUES ('tst-u3@example.test', '$2b$12$' || repeat('c', 53), 'Сидоров Сидор') RETURNING id INTO v_u3;
    INSERT INTO users (email, password_hash, full_name, role) VALUES ('tst-adm@example.test', '$2b$12$' || repeat('d', 53), 'Админов Админ', 'admin') RETURNING id INTO v_adm;

    -- Пополнение u1 и u2 по 10 000 ₽ через настоящие платежи и журнал (триггер обновит balance).
    FOREACH v_uid IN ARRAY ARRAY[v_u1, v_u2] LOOP
        v_n := v_n + 1;
        INSERT INTO payments (user_id, provider, provider_payment_id, amount, status, paid_at)
        VALUES (v_uid, 'test', 'tst-fixture-' || v_n, 10000, 'succeeded', now()) RETURNING id INTO v_pay;
        INSERT INTO transactions (user_id, type, amount, payment_id, description)
        VALUES (v_uid, 'topup', 10000, v_pay, 'fixture');
    END LOOP;

    INSERT INTO templates (name, docker_image, default_disk_gb, is_public) VALUES ('TST PyTorch', 'pytorch/pytorch:test', 50, true) RETURNING id INTO v_tpl;

    PERFORM set_config('fx.dc1', v_dc1::text, true);   PERFORM set_config('fx.dc2', v_dc2::text, true);
    PERFORM set_config('fx.ma', v_ma::text, true);     PERFORM set_config('fx.mb', v_mb::text, true);
    PERFORM set_config('fx.n1', v_n1::text, true);     PERFORM set_config('fx.n2', v_n2::text, true);
    PERFORM set_config('fx.n3', v_n3::text, true);
    PERFORM set_config('fx.u1', v_u1::text, true);     PERFORM set_config('fx.u2', v_u2::text, true);
    PERFORM set_config('fx.u3', v_u3::text, true);     PERFORM set_config('fx.adm', v_adm::text, true);
    PERFORM set_config('fx.tpl', v_tpl::text, true);

    INSERT INTO volumes (user_id, datacenter_id, name, size_gb) VALUES (v_u1, v_dc1, 'vol-msk', 100) RETURNING id INTO v_vol1;
    INSERT INTO volumes (user_id, datacenter_id, name, size_gb) VALUES (v_u1, v_dc2, 'vol-kzn', 100) RETURNING id INTO v_vol2;
    PERFORM set_config('fx.vol1', v_vol1::text, true); PERFORM set_config('fx.vol2', v_vol2::text, true);
END
$$;

-- 08: шифрование секретов env: правильный ключ расшифровывает, неверный и пустой — нет; ключ в БД не хранится;
-- секреты доступны только владельцу инстанса.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_system() \g /dev/null
DO $$
BEGIN
    PERFORM set_config('fx.i1', fn_start_instance(pg_temp.fx('u1'), pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'env-1')::text, true);
    PERFORM set_config('fx.i2', fn_start_instance(pg_temp.fx('u2'), pg_temp.fx('dc1'), pg_temp.fx('ma'), 1, 'on_demand', pg_temp.fx('tpl'), 'env-2')::text, true);
END
$$;

SELECT pg_temp.as_user(pg_temp.fx('u1')), set_config('app.enc_key', 'correct-horse-battery', true) \g /dev/null
DO $$
DECLARE
    i1 uuid := pg_temp.fxt('i1')::uuid; v_raw bytea;
BEGIN
    PERFORM fn_env_set(i1, 'API_TOKEN', 's3cr3t-value-123');
    SELECT value_encrypted INTO v_raw FROM instance_env_vars WHERE instance_id = i1 AND name = 'API_TOKEN';
    PERFORM pg_temp.assert_true(v_raw IS NOT NULL AND v_raw <> convert_to('s3cr3t-value-123', 'UTF8'), 'stored value differs from the plain text');
    PERFORM pg_temp.assert_true(position(convert_to('s3cr3t', 'UTF8') IN v_raw) = 0, 'plain text is not visible inside the stored bytes');

    PERFORM pg_temp.assert_eq(fn_env_get(i1, 'API_TOKEN'), 's3cr3t-value-123', 'the right key decrypts the value');
    PERFORM pg_temp.assert_eq(fn_env_get(i1, 'NO_SUCH'), NULL::text, 'missing variable returns NULL');

    -- то же напрямую в SQL (так делает приложение без функции)
    PERFORM pg_temp.assert_eq(pgp_sym_decrypt(v_raw, 'correct-horse-battery'), 's3cr3t-value-123', 'pgp_sym_decrypt with the right key');

    PERFORM set_config('app.enc_key', 'wrong-key', true);
    PERFORM pg_temp.assert_raises(format('SELECT fn_env_get(%L, ''API_TOKEN'')', i1), '39000', 'a wrong key does not decrypt (error, no garbage)');
    PERFORM pg_temp.assert_raises(format('SELECT pgp_sym_decrypt(value_encrypted, ''wrong-key'') FROM instance_env_vars WHERE instance_id = %L', i1), '39000', 'pgp_sym_decrypt with a wrong key fails');

    PERFORM set_config('app.enc_key', '', true);
    PERFORM pg_temp.assert_raises(format('SELECT fn_env_set(%L, ''X'', ''y'')', i1), 'GR006', 'empty app.enc_key: writing is an explicit error');
    PERFORM pg_temp.assert_raises(format('SELECT fn_env_get(%L, ''API_TOKEN'')', i1), 'GR006', 'empty app.enc_key: reading is an explicit error');
    PERFORM set_config('app.enc_key', 'correct-horse-battery', true);

    -- перезапись значения и формат имени
    PERFORM fn_env_set(i1, 'API_TOKEN', 'rotated');
    PERFORM pg_temp.assert_eq(fn_env_get(i1, 'API_TOKEN'), 'rotated', 'value can be overwritten');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_env_vars WHERE instance_id = i1), 1, 'overwrite does not add a second row');
    PERFORM pg_temp.assert_raises(format('SELECT fn_env_set(%L, ''1BAD-NAME'', ''y'')', i1), '23514', 'invalid variable name is rejected');
END
$$;

-- Чужой инстанс
SELECT pg_temp.as_user(pg_temp.fx('u2')) \g /dev/null
DO $$
DECLARE
    i1 uuid := pg_temp.fxt('i1')::uuid;
BEGIN
    PERFORM pg_temp.assert_raises(format('SELECT fn_env_get(%L, ''API_TOKEN'')', i1), '42501', 'another user cannot read secrets through the function');
    PERFORM pg_temp.assert_raises(format('SELECT fn_env_set(%L, ''API_TOKEN'', ''pwn'')', i1), '42501', 'another user cannot overwrite secrets through the function');
END
$$;

SET LOCAL ROLE gpu_rent_app;
DO $$
DECLARE
    n int;
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_env_vars), 0, 'RLS: another user sees no env rows');
    DELETE FROM instance_env_vars;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM pg_temp.assert_eq(n, 0, 'RLS: another user cannot delete env rows');
    PERFORM pg_temp.assert_raises(format('INSERT INTO instance_env_vars (instance_id, name, value_encrypted) VALUES (%L, ''RAW'', ''\x00''::bytea)', pg_temp.fxt('i1')),
                                  '42501', 'app cannot insert raw (unencrypted) values bypassing fn_env_set');
END
$$;
RESET ROLE;
SELECT pg_temp.as_user(pg_temp.fx('u1')) \g /dev/null
SET LOCAL ROLE gpu_rent_app;
DO $$
BEGIN
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_env_vars), 1, 'RLS: the owner sees his env row');
END
$$;
RESET ROLE;

-- Удаление инстанса уносит его секреты (ON DELETE CASCADE)
DO $$
DECLARE
    v_raw uuid := pg_temp.raw_instance(pg_temp.fx('u1'), pg_temp.fx('n1'), pg_temp.fx('ma'), 1, 'pending');
BEGIN
    INSERT INTO instance_env_vars (instance_id, name, value_encrypted) VALUES (v_raw, 'A', pgp_sym_encrypt('x', 'k'));
    DELETE FROM instances WHERE id = v_raw;
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instance_env_vars WHERE instance_id = v_raw), 0, 'env vars are removed together with the instance (CASCADE)');
END
$$;
ROLLBACK;

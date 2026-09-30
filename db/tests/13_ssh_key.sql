-- 13: SSH-ключ инстанса (FR-07): запись ssh_key_id при запуске, отказ для чужого ключа (составной FK),
-- удаление ключа обнуляет ссылку, но не трогает инстанс.
\set ON_ERROR_STOP on
BEGIN;
\ir _helpers.sql
\ir _fixture.sql
SELECT pg_temp.as_system() \g /dev/null
DO $$
DECLARE
    u1 bigint := pg_temp.fx('u1'); u2 bigint := pg_temp.fx('u2');
    dc1 bigint := pg_temp.fx('dc1'); ma bigint := pg_temp.fx('ma');
    k1 bigint; k2 bigint; v_id uuid; v_status instance_status;
BEGIN
    INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES (u1, 'k-u1', 'ssh-ed25519 AAAA-u1', 'SHA256:ssh-test-u1') RETURNING id INTO k1;
    INSERT INTO ssh_keys (user_id, name, public_key, fingerprint) VALUES (u2, 'k-u2', 'ssh-ed25519 AAAA-u2', 'SHA256:ssh-test-u2') RETURNING id INTO k2;

    v_id := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'no-key');
    PERFORM pg_temp.assert_true((SELECT ssh_key_id IS NULL FROM instances WHERE id = v_id), 'start without a key leaves ssh_key_id NULL');

    v_id := fn_start_instance(u1, dc1, ma, 1, 'on_demand', pg_temp.fx('tpl'), 'with-key', NULL, NULL, k1);
    PERFORM pg_temp.assert_eq((SELECT ssh_key_id FROM instances WHERE id = v_id), k1, 'start with own key stores ssh_key_id');

    PERFORM pg_temp.assert_raises(
        format('SELECT fn_start_instance(%s, %s, %s, 1, ''on_demand'', %s, ''alien-key'', NULL, NULL, %s)', u1, dc1, ma, pg_temp.fx('tpl'), k2),
        '23503', 'start with the key of another user is rejected (composite FK)');
    PERFORM pg_temp.assert_eq((SELECT count(*)::int FROM instances WHERE name = 'alien-key'), 0, 'rejected start leaves no instance behind');

    PERFORM pg_temp.assert_raises(
        format('UPDATE instances SET ssh_key_id = %s WHERE id = %L', k2, v_id),
        '23503', 'instance cannot be re-pointed to the key of another user');

    DELETE FROM ssh_keys WHERE id = k1;
    SELECT status INTO v_status FROM instances WHERE id = v_id;
    PERFORM pg_temp.assert_true((SELECT ssh_key_id IS NULL FROM instances WHERE id = v_id), 'deleting the key nulls instances.ssh_key_id');
    PERFORM pg_temp.assert_eq(v_status, 'running'::instance_status, 'the instance survives the key deletion and keeps running');
    PERFORM pg_temp.assert_eq((SELECT user_id FROM instances WHERE id = v_id), u1, 'user_id is kept after SET NULL (ssh_key_id)');
END
$$;
ROLLBACK;

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Один раз перед всеми интеграционными файлами: пересоздаёт БД gpu_rent_test тем же скриптом, которым её готовят вручную.
export default function setup(): void {
  const script = resolve(__dirname, '../../../db/scripts/test_server_db.sh');
  try {
    execFileSync('bash', [script], { stdio: 'pipe', env: process.env, timeout: 120_000 });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    throw new Error(`Не удалось подготовить тестовую БД:\n${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}${err.message}`);
  }
}

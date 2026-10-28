import pino from 'pino';
import type { Config } from './config';

/**
 * JSON-логи в stdout (Vercel собирает их сам). Пароли, токены и cookie в лог не попадают: тела запросов
 * не логируются вообще, а заголовки с секретами закрыты redact на случай, если их кто-то добавит.
 */
export function createLogger(config: Pick<Config, 'logLevel' | 'nodeEnv'>): pino.Logger {
  return pino({
    level: config.nodeEnv === 'test' ? 'silent' : config.logLevel,
    base: undefined,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie', 'password', 'token', '*.password', '*.token'],
      censor: '[скрыто]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

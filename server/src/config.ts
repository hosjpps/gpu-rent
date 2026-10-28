import { z } from 'zod';

export interface RateLimit {
  max: number;
  windowSeconds: number;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProd: boolean;
  version: string;
  logLevel: string;
  databaseUrl: string;
  poolMax: number;
  encKey: string;
  webhookSecret: string;
  cronSecret: string | undefined;
  demoMail: boolean;
  demoPayments: boolean;
  appUrl: string | undefined;
  allowedOrigins: string[];
  bcryptCost: number;
  cookieSecure: boolean;
  cookieName: string;
  sessionTtlSeconds: number;
  trustProxy: boolean | number;
  limits: {
    /** Все попытки на один email, с любых адресов: защита от распределённого подбора. Выше лимита пары, чтобы один адрес не мог запереть владельца. */
    loginEmail: RateLimit;
    /** Попытки на пару «email + адрес клиента»: чужой адрес не может запереть владельца аккаунта. */
    loginEmailIp: RateLimit;
    loginIp: RateLimit;
    registerIp: RateLimit;
    password: RateLimit;
    resend: RateLimit;
  };
}

const flag = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

const int = (name: string, fallback: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        ctx.addIssue({ code: 'custom', message: `${name}: нужно целое число больше нуля` });
        return z.NEVER;
      }
      return n;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL не задан'),
  ENC_KEY: z.string().min(16, 'ENC_KEY должен быть не короче 16 символов'),
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET должен быть не короче 16 символов'),
  CRON_SECRET: z.string().min(16, 'CRON_SECRET должен быть не короче 16 символов').optional(),
  DEMO_MAIL: z.string().optional(),
  DEMO_PAYMENTS: z.string().optional(),
  APP_URL: z.string().url().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  BCRYPT_COST: int('BCRYPT_COST', 12),
  COOKIE_SECURE: z.string().optional(),
  DB_POOL_MAX: int('DB_POOL_MAX', 2),
  LOG_LEVEL: z.string().default('info'),
  AUTH_LOGIN_EMAIL_MAX: int('AUTH_LOGIN_EMAIL_MAX', 20),
  AUTH_LOGIN_EMAIL_IP_MAX: int('AUTH_LOGIN_EMAIL_IP_MAX', 5),
  AUTH_LOGIN_IP_MAX: int('AUTH_LOGIN_IP_MAX', 60),
  AUTH_REGISTER_IP_MAX: int('AUTH_REGISTER_IP_MAX', 10),
});

/**
 * Читает и проверяет переменные окружения. Вызывается при создании приложения, а не при импорте модуля:
 * так импорт app.ts не требует окружения и не имеет побочных эффектов.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Неверная конфигурация окружения:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const cookieSecure = flag(e.COOKIE_SECURE, isProd);
  const onVercel = Boolean(env.VERCEL);
  return {
    nodeEnv: e.NODE_ENV,
    isProd,
    version: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? '1.0.0',
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    poolMax: e.DB_POOL_MAX,
    encKey: e.ENC_KEY,
    webhookSecret: e.WEBHOOK_SECRET,
    cronSecret: e.CRON_SECRET,
    demoMail: flag(e.DEMO_MAIL, false),
    demoPayments: flag(e.DEMO_PAYMENTS, false),
    appUrl: e.APP_URL?.replace(/\/+$/, ''),
    allowedOrigins: (e.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    bcryptCost: e.BCRYPT_COST,
    cookieSecure,
    // Префикс __Host- требует Secure, Path=/ и отсутствия Domain: cookie нельзя подменить с поддомена.
    cookieName: cookieSecure ? '__Host-sid' : 'sid',
    sessionTtlSeconds: 7 * 24 * 3600,
    // За прокси Vercel клиентский адрес — последний элемент X-Forwarded-For, добавленный самой платформой.
    trustProxy: onVercel ? 1 : false,
    limits: {
      loginEmail: { max: e.AUTH_LOGIN_EMAIL_MAX, windowSeconds: 15 * 60 },
      loginEmailIp: { max: e.AUTH_LOGIN_EMAIL_IP_MAX, windowSeconds: 15 * 60 },
      loginIp: { max: e.AUTH_LOGIN_IP_MAX, windowSeconds: 15 * 60 },
      registerIp: { max: e.AUTH_REGISTER_IP_MAX, windowSeconds: 3600 },
      password: { max: 5, windowSeconds: 15 * 60 },
      resend: { max: 5, windowSeconds: 3600 },
    },
  };
}

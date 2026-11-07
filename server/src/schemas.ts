import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { badRequest, zodDetails } from './errors';

/** Разбирает вход по схеме; при ошибке — 400 с перечнем полей. Схемы запросов строгие (.strict()): лишнее поле в теле — ошибка 400, исключение — тело вебхука платежей. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Некорректные данные запроса', 'VALIDATION_ERROR', zodDetails(r.error));
  return r.data;
}

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Слишком короткий email')
  .max(254, 'Слишком длинный email')
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Неверный формат email');

// bcrypt учитывает только первые 72 байта пароля: более длинные пароли отвергаем, а не обрезаем молча.
export const passwordSchema = z
  .string()
  .min(8, 'Пароль должен быть не короче 8 символов')
  .refine((s) => byteLength(s) <= 72, 'Пароль не должен быть длиннее 72 байт');

export const fullNameSchema = z.string().trim().min(2, 'Слишком короткое имя').max(120, 'Слишком длинное имя');

export const registerBody = z.object({ email: emailSchema, password: passwordSchema, fullName: fullNameSchema }).strict();
export const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(200) }).strict();
export const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }).strict();
export const verifyBody = z.object({ token: z.string().min(20).max(200) }).strict();

/** Положительный целый id из пути или тела. */
export const idSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const idParams = z.object({ id: idSchema });
export const uuidParams = z.object({ id: z.string().uuid() });

export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

/** Десятичная сумма с не более чем p знаками после запятой, строкой или числом. */
export function decimalSchema(maxDecimals: number, min: number, max: number) {
  return z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((s) => new RegExp(`^\\d{1,9}(\\.\\d{1,${maxDecimals}})?$`).test(s), `Сумма: число не более чем с ${maxDecimals} знаками после запятой`)
    .refine((s) => Number(s) >= min && Number(s) <= max, `Сумма должна быть от ${min} до ${max}`);
}

const SSH_TYPES = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/;

/** Сколько полей [длина][байты] лежит в blob ключа; null, если поля не укладываются в него точно (ключ обрезан или с хвостом). */
function countFields(blob: Buffer): number | null {
  let pos = 0;
  let n = 0;
  while (pos < blob.length) {
    if (pos + 4 > blob.length) return null;
    pos += 4 + blob.readUInt32BE(pos);
    if (pos > blob.length) return null;
    n++;
  }
  return n;
}

/** Разбирает публичный ключ OpenSSH «тип base64 [комментарий]» и считает отпечаток SHA256 (как ssh-keygen -l). */
export function parseSshPublicKey(raw: string): { normalized: string; fingerprint: string } | null {
  const m = /^(\S+) ([A-Za-z0-9+/]+={0,3})(?: (.{1,200}))?$/.exec(raw.trim());
  if (!m || !m[1] || !m[2] || !SSH_TYPES.test(m[1])) return null;
  const blob = Buffer.from(m[2], 'base64');
  if (blob.length < 8) return null;
  // внутри ключа первым полем лежит его же тип с префиксом длины: так отсекаются случайные строки
  const typeLen = blob.readUInt32BE(0);
  if (blob.subarray(4, 4 + typeLen).toString('ascii') !== m[1]) return null;
  // ed25519: тип + ключ; rsa: тип + e + n; ecdsa: тип + кривая + точка
  if (countFields(blob) !== (m[1] === 'ssh-ed25519' ? 2 : 3)) return null;
  const fingerprint = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { normalized: m[3] ? `${m[1]} ${m[2]} ${m[3]}` : `${m[1]} ${m[2]}`, fingerprint };
}

export const sshKeyBody = z
  .object({ name: z.string().trim().min(1).max(64), publicKey: z.string().min(20).max(4000) })
  .strict();

export const apiKeyBody = z
  .object({
    name: z.string().trim().min(1).max(64),
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .refine((s) => new Date(s).getTime() > Date.now(), 'Срок действия должен быть в будущем')
      .optional(),
  })
  .strict();

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const createInstanceBody = z
  .object({
    name: z.string().trim().min(1).max(64),
    datacenterCode: z.string().trim().regex(/^[A-Za-z0-9-]{2,16}$/, 'Неверный код дата-центра'),
    gpuModel: z.string().trim().min(1).max(64),
    gpuCount: z.number().int().min(1).max(8),
    pricingType: z.enum(['on_demand', 'spot']),
    templateId: idSchema,
    containerDiskGb: z.number().int().min(10).max(2000).optional(),
    volumeId: idSchema.optional(),
    sshKeyId: idSchema.optional(),
    env: z
      .record(z.string().regex(envName, 'Неверное имя переменной окружения').max(64), z.string().max(2000))
      .refine((r) => Object.keys(r).length <= 30, 'Не более 30 переменных окружения')
      .optional(),
  })
  .strict();

export const createVolumeBody = z
  .object({
    name: z.string().trim().min(1).max(64),
    datacenterCode: z.string().trim().regex(/^[A-Za-z0-9-]{2,16}$/, 'Неверный код дата-центра'),
    sizeGb: z.number().int().min(10).max(10000),
  })
  .strict();
export const extendVolumeBody = z.object({ sizeGb: z.number().int().min(10).max(10000) }).strict();

export const createPaymentBody = z.object({ amount: decimalSchema(2, 10, 100000) }).strict();

export const pricingTypeSchema = z.enum(['on_demand', 'spot']);
export const setPriceBody = z
  .object({
    datacenterCode: z.string().trim().regex(/^[A-Za-z0-9-]{2,16}$/),
    gpuModel: z.string().trim().min(1).max(64),
    pricingType: pricingTypeSchema,
    pricePerHour: decimalSchema(4, 0.01, 100000),
  })
  .strict();
export const nodeStatusBody = z.object({ status: z.enum(['online', 'maintenance', 'offline']) }).strict();

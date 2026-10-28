import type { ZodTypeAny, z } from 'zod';
import { badRequest } from './errors';

/** Курсор keyset-пагинации: непрозрачная строка base64url от JSON. Содержимое проверяется схемой, доверия к нему нет. */
export function encodeCursor(payload: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<S extends ZodTypeAny>(cursor: string, schema: S): z.infer<S> {
  try {
    const json: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const r = schema.safeParse(json);
    if (r.success) return r.data;
  } catch {
    // падаем ниже одной и той же ошибкой
  }
  throw badRequest('Некорректный курсор страницы', 'INVALID_CURSOR');
}

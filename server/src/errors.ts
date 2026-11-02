import { ZodError } from 'zod';

/** Ошибка с HTTP-статусом и стабильным кодом для клиента. Сообщение — по-русски, без внутренних подробностей. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Требуется вход в систему', code = 'UNAUTHORIZED') => new AppError(401, code, message);
export const forbidden = (message = 'Недостаточно прав', code = 'FORBIDDEN') => new AppError(403, code, message);
export const notFound = (message = 'Объект не найден', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
export const unprocessable = (message: string, code = 'VALIDATION') => new AppError(422, code, message);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, 'TOO_MANY_REQUESTS', `Слишком много попыток. Повторите через ${retryAfterSeconds} с`, undefined, {
    'Retry-After': String(retryAfterSeconds),
  });

interface DbErrorInfo {
  status: number;
  code: string;
  message: string;
}

/**
 * Коды SQLSTATE, которые функции БД (0008, 0013) и ограничения возвращают намеренно.
 * Текст ошибки PostgreSQL клиенту не отдаётся: в нём бывают имена таблиц и значения.
 */
const DB_ERRORS: Record<string, DbErrorInfo> = {
  GR001: { status: 409, code: 'NO_CAPACITY', message: 'Нет свободных GPU выбранной модели в этом дата-центре' },
  GR002: { status: 402, code: 'INSUFFICIENT_FUNDS', message: 'Недостаточно средств: на балансе должна быть сумма не меньше стоимости одного часа' },
  GR003: { status: 409, code: 'INVALID_STATE', message: 'Операция недопустима в текущем состоянии объекта' },
  GR004: { status: 404, code: 'NOT_FOUND', message: 'Объект не найден' },
  GR005: { status: 422, code: 'CONSISTENCY', message: 'Данные запроса не согласованы между собой' },
  GR006: { status: 500, code: 'CONFIG', message: 'Ошибка конфигурации сервера' },
  '22021': { status: 400, code: 'VALIDATION_ERROR', message: 'Недопустимые символы в тексте (например, NUL)' },
  '22P05': { status: 400, code: 'VALIDATION_ERROR', message: 'Недопустимые символы в тексте (например, NUL)' },
  '23505': { status: 409, code: 'CONFLICT', message: 'Такая запись уже существует' },
  '23503': { status: 422, code: 'VALIDATION', message: 'Ссылка на несуществующий или чужой объект' },
  '23514': { status: 422, code: 'VALIDATION', message: 'Значение не проходит проверку ограничений' },
  '23P01': { status: 409, code: 'CONFLICT', message: 'Конфликт с другой записью, повторите запрос' },
  '23001': { status: 409, code: 'INVALID_STATE', message: 'Операция недопустима в текущем состоянии объекта' },
  '40001': { status: 409, code: 'CONFLICT', message: 'Конфликт параллельных операций, повторите запрос' },
  '40P01': { status: 409, code: 'CONFLICT', message: 'Конфликт параллельных операций, повторите запрос' },
  '42501': { status: 403, code: 'FORBIDDEN', message: 'Недостаточно прав' },
  '57014': { status: 503, code: 'TIMEOUT', message: 'Запрос выполнялся слишком долго, повторите позже' },
  '55P03': { status: 503, code: 'TIMEOUT', message: 'Ресурс занят, повторите позже' },
};

const DB_UNAVAILABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '57P01', '57P03', '53300', '08006', '08001']);

/** SQLSTATE из ошибки pg (поле code) либо undefined. */
export function sqlState(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return undefined;
}

export function mapDbError(e: unknown): AppError | null {
  const state = sqlState(e);
  if (state === undefined) {
    // pool.connect по таймауту бросает Error без кода
    if (e instanceof Error && /timeout exceeded when trying to connect|Connection terminated/i.test(e.message)) {
      return new AppError(503, 'DB_UNAVAILABLE', 'База данных временно недоступна');
    }
    return null;
  }
  if (DB_UNAVAILABLE.has(state)) return new AppError(503, 'DB_UNAVAILABLE', 'База данных временно недоступна');
  const info = DB_ERRORS[state];
  return info ? new AppError(info.status, info.code, info.message) : null;
}

const ZOD_MESSAGES: Record<string, string> = {
  invalid_type: 'Неверный тип значения',
  invalid_string: 'Неверный формат',
  invalid_enum_value: 'Недопустимое значение',
  unrecognized_keys: 'Лишние поля в запросе',
};

const HAS_CYRILLIC = /[А-Яа-яЁё]/;

function zodMessage(i: ZodError['issues'][number]): string {
  if (i.code === 'invalid_type' && i.received === 'undefined') return 'Обязательное поле';
  // Русский текст, заданный в схеме, важнее; английские тексты zod по умолчанию заменяем
  if (HAS_CYRILLIC.test(i.message)) return i.message;
  if (i.code === 'too_small' || i.code === 'too_big') {
    const small = i.code === 'too_small';
    const bound = small ? i.minimum : i.maximum;
    if (i.type === 'string') return small ? `Не короче ${bound} симв.` : `Не длиннее ${bound} симв.`;
    if (i.type === 'array') return small ? `Не меньше ${bound} элементов` : `Не больше ${bound} элементов`;
    return small ? `Не меньше ${bound}` : `Не больше ${bound}`;
  }
  return ZOD_MESSAGES[i.code] ?? 'Неверное значение';
}

export function zodDetails(e: ZodError): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.join('.'), message: zodMessage(i) }));
}

/** Приводит любую пойманную ошибку к AppError. Неизвестные ошибки становятся 500 без подробностей. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ZodError) return new AppError(400, 'VALIDATION_ERROR', 'Некорректные данные запроса', zodDetails(e));
  // Express бросает URIError, когда параметр пути не раскодировать (например, /instances/%): это ошибка клиента, не сервера
  if (e instanceof URIError) return new AppError(400, 'BAD_REQUEST', 'Некорректный адрес запроса');
  // Ошибка распаковки тела (Content-Encoding: gzip с мусором): zlib даёт code Z_*, status у неё нет
  if (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' && (e as { code: string }).code.startsWith('Z_')) {
    return new AppError(400, 'BAD_REQUEST', 'Тело запроса не удалось распаковать');
  }
  if (typeof e === 'object' && e !== null && 'type' in e) {
    const type = (e as { type: unknown }).type;
    if (type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Тело запроса больше 32 КБ');
    if (type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Тело запроса не является корректным JSON');
    if (type === 'charset.unsupported' || type === 'encoding.unsupported') return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Неподдерживаемая кодировка запроса');
  }
  return mapDbError(e) ?? new AppError(500, 'INTERNAL', 'Внутренняя ошибка сервера');
}

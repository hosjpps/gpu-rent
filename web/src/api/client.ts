// Единый HTTP-клиент: все запросы к API идут только через request().

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Запасные тексты на случай, если сервер ответил не JSON-ошибкой (например, 502 от платформы)
const FALLBACK: Record<number, string> = {
  400: 'Некорректный запрос.',
  401: 'Нужно войти в аккаунт.',
  402: 'Недостаточно средств на балансе.',
  403: 'Недостаточно прав для этого действия.',
  404: 'Не найдено.',
  409: 'Действие сейчас невозможно: состояние ресурса изменилось.',
  422: 'Данные не прошли проверку.',
  429: 'Слишком много запросов. Подождите немного и повторите.',
  500: 'Ошибка на сервере. Попробуйте позже.',
  502: 'Сервер временно недоступен. Попробуйте позже.',
  503: 'Сервер временно недоступен. Попробуйте позже.',
  504: 'Сервер не ответил вовремя. Попробуйте позже.',
};

type Query = Record<string, string | number | boolean | undefined | null>;

interface Options {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Query): string {
  const url = `/api${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function request<T>(method: string, path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Сервер требует этот заголовок для небезопасных методов (защита от CSRF)
    'X-Requested-With': 'fetch',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Нет связи с сервером. Проверьте подключение к интернету.');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? FALLBACK[res.status] ?? `Ошибка ${res.status}`,
      err?.details,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  del: <T = void>(path: string) => request<T>('DELETE', path),
};

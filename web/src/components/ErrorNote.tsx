import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';

/** Текст ошибки для пользователя. Сообщения сервера уже на русском. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // Для ошибок проверки сервер в details называет причину: показываем первую
    const first = Array.isArray(error.details) ? (error.details[0] as { message?: unknown } | undefined)?.message : undefined;
    return typeof first === 'string' && first ? `${error.message}: ${first}` : error.message;
  }
  if (error instanceof Error) return 'Что-то пошло не так. Попробуйте ещё раз.';
  return 'Неизвестная ошибка.';
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const status = error instanceof ApiError ? error.status : 0;
  const code = error instanceof ApiError ? error.code : '';
  return (
    <div className="alert alert-error" role="alert">
      <span>{errorMessage(error)}</span>
      {(status === 402 || code === 'INSUFFICIENT_FUNDS') && (
        <>
          {' '}
          <Link to="/billing">Пополнить баланс</Link>
        </>
      )}
      {code === 'EMAIL_NOT_VERIFIED' && (
        <>
          {' '}
          <Link to="/settings">Подтвердить email</Link>
        </>
      )}
    </div>
  );
}

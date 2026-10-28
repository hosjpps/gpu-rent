import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe, useVerifyEmail } from '../api/hooks';
import { ErrorNote } from '../components/ErrorNote';
import { Spinner } from '../components/ui';

// Страница, на которую ведёт ссылка из письма (в демо-режиме: из настроек)
export function VerifyPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const verify = useVerifyEmail();
  const me = useMe();
  const started = useRef(false);

  useEffect(() => {
    // StrictMode в разработке вызывает эффект дважды, а токен одноразовый
    if (token && !started.current) {
      started.current = true;
      verify.mutate(token);
    }
  }, [token, verify]);

  return (
    <div className="auth-card card stack">
      <h1>Подтверждение email</h1>
      {!token && <p>В ссылке нет токена подтверждения.</p>}
      {token && verify.isPending && <Spinner label="Проверяем ссылку…" />}
      {verify.isSuccess && (
        <div className="alert alert-ok" role="status">
          Email подтверждён. Теперь можно запускать инстансы.
        </div>
      )}
      <ErrorNote error={verify.error} />
      <p>{me.data ? <Link to="/instances">К инстансам</Link> : <Link to="/login">Войти</Link>}</p>
    </div>
  );
}

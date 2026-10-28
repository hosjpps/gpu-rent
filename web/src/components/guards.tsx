import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useLogout, useMe } from '../api/hooks';
import { Spinner } from './ui';
import { ErrorNote } from './ErrorNote';

// Сервер отвечает 403 USER_BLOCKED на любой запрос заблокированного пользователя, в том числе на /auth/me
function Blocked() {
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <div className="card" role="alert">
      <h1>Аккаунт заблокирован</h1>
      <p className="muted">Доступ к сервису закрыт администратором. Если это ошибка, обратитесь в поддержку.</p>
      <button type="button" className="btn" disabled={logout.isPending} onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}>
        Выйти
      </button>
    </div>
  );
}

/** Страницы только для вошедших; после входа вернём пользователя туда, куда он шёл */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  if (me.isLoading) return <Spinner />;
  if (me.error instanceof ApiError && me.error.code === 'USER_BLOCKED') return <Blocked />;
  if (me.error) return <ErrorNote error={me.error} />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/** Админка. Проверка на клиенте только прячет разделы: настоящую защиту делает сервер (403) */
export function RequireAdmin() {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  if (me.data?.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

/** Вход и регистрация не нужны уже вошедшему */
export function GuestOnly() {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  if (me.data) return <Navigate to="/instances" replace />;
  return <Outlet />;
}

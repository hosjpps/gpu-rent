import { useEffect, useState } from 'react';
import { useAdminUsers, useBlockUser, useMe } from '../../api/hooks';
import type { AdminUser } from '../../api/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { Empty, QueryState } from '../../components/ui';
import { formatDateTime, formatMoney } from '../../lib/format';

export default function UsersPage() {
  const [search, setSearch] = useState('');
  // запрос уходит на сервер через паузу после последнего символа
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const users = useAdminUsers(q);
  const me = useMe().data;
  const block = useBlockUser();
  const toast = useToast();
  const [target, setTarget] = useState<AdminUser | null>(null);

  const rows = users.data ?? [];

  return (
    <>
      <div className="filters">
        <label className="field">
          <span className="field-label">Поиск</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="email или имя" />
        </label>
      </div>
      <QueryState isLoading={users.isLoading} error={users.error} onRetry={() => void users.refetch()} />
      {users.data && rows.length === 0 && <Empty title="Никого не найдено">Измените запрос поиска.</Empty>}
      {users.data && rows.length > 0 && (
        <div className="card flush">
          <table className="table responsive" data-testid="users-table">
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Роль</th>
                <th>Статус</th>
                <th className="num">Баланс</th>
                <th>Регистрация</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} data-email={u.email}>
                  <td data-label="Пользователь">
                    <strong>{u.fullName}</strong>
                    <div className="muted small">{u.email}</div>
                  </td>
                  <td data-label="Роль">{u.role === 'admin' ? 'Админ' : 'Клиент'}</td>
                  <td data-label="Статус">
                    <span className={u.status === 'blocked' ? 'badge badge-failed' : 'badge badge-running'}>
                      {u.status === 'blocked' ? 'Заблокирован' : 'Активен'}
                    </span>
                  </td>
                  <td data-label="Баланс" className="num">
                    {formatMoney(u.balance)}
                  </td>
                  <td data-label="Регистрация">{formatDateTime(u.createdAt)}</td>
                  <td className="actions">
                    <button
                      type="button"
                      className={u.status === 'blocked' ? 'btn btn-sm' : 'btn btn-sm btn-danger-outline'}
                      disabled={u.id === me?.id || u.role === 'admin'}
                      title={u.role === 'admin' ? 'Администраторов блокировать нельзя' : undefined}
                      onClick={() => {
                        block.reset();
                        setTarget(u);
                      }}
                    >
                      {u.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target && (
        <ConfirmDialog
          title={target.status === 'blocked' ? 'Разблокировать пользователя?' : 'Заблокировать пользователя?'}
          confirmText={target.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}
          danger={target.status !== 'blocked'}
          pending={block.isPending}
          error={block.error}
          onCancel={() => setTarget(null)}
          onConfirm={() =>
            block.mutate(
              { id: target.id, block: target.status !== 'blocked' },
              {
                onSuccess: () => {
                  toast(target.status === 'blocked' ? 'Пользователь разблокирован' : 'Пользователь заблокирован');
                  setTarget(null);
                },
              },
            )
          }
        >
          {target.status === 'blocked'
            ? `${target.email} снова сможет входить и пользоваться сервисом.`
            : `${target.email} не сможет войти и пользоваться сервисом. Запущенные инстансы продолжат работать и списывать оплату, пока хватает баланса.`}
        </ConfirmDialog>
      )}
    </>
  );
}

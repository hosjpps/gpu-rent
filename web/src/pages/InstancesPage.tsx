import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInstances, useMe } from '../api/hooks';
import { InstanceActions } from '../components/InstanceActions';
import { Runtime } from '../components/Runtime';
import { Empty, PageHead, PricingBadge, QueryState, StatusBadge } from '../components/ui';
import { formatMoney, toNumber } from '../lib/format';

export function InstancesPage() {
  const me = useMe().data;
  const [showTerminated, setShowTerminated] = useState(false);
  const [all, setAll] = useState(false);
  const instances = useInstances(all);

  const list = (instances.data ?? []).filter((i) => showTerminated || i.status !== 'terminated');
  const running = (instances.data ?? []).filter((i) => i.status === 'running');
  const burn = running.reduce((sum, i) => sum + toNumber(i.pricePerHour), 0);

  return (
    <>
      <PageHead title="Мои инстансы">
        <Link to="/" className="btn btn-primary">
          Новый инстанс
        </Link>
      </PageHead>

      <div className="stats">
        <div className="stat">
          <span className="stat-label">Работает</span>
          <span className="stat-value">{running.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Сейчас тратится</span>
          <span className="stat-value">{formatMoney(burn)}/ч</span>
        </div>
      </div>

      <div className="filters">
        <label className="check">
          <input type="checkbox" checked={showTerminated} onChange={(e) => setShowTerminated(e.target.checked)} />
          Показывать удалённые
        </label>
        {me?.role === 'admin' && (
          <label className="check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Все пользователи
          </label>
        )}
        <span className="muted small">Статусы обновляются автоматически</span>
      </div>

      <QueryState isLoading={instances.isLoading} error={instances.error} onRetry={() => void instances.refetch()} />

      {instances.data && list.length === 0 && (
        <Empty title="Инстансов пока нет">
          Выберите GPU в <Link to="/">каталоге</Link> и запустите первый инстанс.
        </Empty>
      )}

      {list.length > 0 && (
        <div className="card flush">
          <table className="table responsive" data-testid="instances-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Статус</th>
                <th>GPU</th>
                <th>Тариф</th>
                <th className="num">Цена, ₽/ч</th>
                <th>Работает</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} data-testid="instance-row" data-name={i.name}>
                  <td data-label="Название">
                    <Link to={`/instances/${i.id}`}>
                      <strong>{i.name}</strong>
                    </Link>
                    {i.owner && <div className="muted small">{i.owner.email}</div>}
                  </td>
                  <td data-label="Статус">
                    <StatusBadge status={i.status} />
                  </td>
                  <td data-label="GPU">
                    {i.gpuModel} × {i.gpuCount}
                    <div className="muted small">{i.datacenter.code}</div>
                  </td>
                  <td data-label="Тариф">
                    <PricingBadge type={i.pricingType} />
                  </td>
                  <td data-label="Цена" className="num">
                    {formatMoney(i.pricePerHour)}
                  </td>
                  <td data-label="Работает">
                    <Runtime instance={i} />
                  </td>
                  <td className="actions">
                    <InstanceActions instance={i} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

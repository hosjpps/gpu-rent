import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInstances, useMe } from '../api/hooks';
import { IconBolt, IconPlus, IconServer, IconWallet } from '../components/icons';
import { InstanceActions } from '../components/InstanceActions';
import { Runtime, SessionCost } from '../components/Runtime';
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
  const stopped = (instances.data ?? []).filter((i) => i.status === 'stopped').length;

  return (
    <>
      <PageHead title="Мои инстансы">
        <Link to="/" className="btn btn-primary">
          <IconPlus size={18} />
          Новый инстанс
        </Link>
      </PageHead>

      <div className="stats">
        <div className="stat">
          <span className="stat-icon" aria-hidden="true">
            <IconBolt />
          </span>
          <span className="stat-label">Работает</span>
          <span className="stat-value mono">{running.length}</span>
        </div>
        <div className="stat">
          <span className="stat-icon" aria-hidden="true">
            <IconWallet />
          </span>
          <span className="stat-label">Сейчас тратится</span>
          <span className="stat-value mono">
            {formatMoney(burn)}
            <span className="stat-unit">/ч</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon" aria-hidden="true">
            <IconServer />
          </span>
          <span className="stat-label">Остановлено</span>
          <span className="stat-value mono">{stopped}</span>
        </div>
      </div>

      <div className="toolbar">
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
        <span className="muted small toolbar-note">
          <span className="live-dot" aria-hidden="true" />
          Статусы обновляются автоматически
        </span>
      </div>

      <QueryState isLoading={instances.isLoading} error={instances.error} onRetry={() => void instances.refetch()} />

      {instances.data && list.length === 0 && (
        <div className="card">
          <Empty
            title="Инстансов пока нет"
            icon={<IconServer size={28} />}
            action={
              <Link to="/" className="btn btn-primary">
                Выбрать GPU
              </Link>
            }
          >
            Выберите видеокарту в каталоге и запустите первый контейнер: оплата начнётся только после старта.
          </Empty>
        </div>
      )}

      {list.length > 0 && (
        <div className="card flush">
          <table className="table responsive instances" data-testid="instances-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Статус</th>
                <th>GPU</th>
                <th>Тариф</th>
                <th className="num">Цена, ₽/ч</th>
                <th>Сеанс</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} data-testid="instance-row" data-name={i.name} className={`inst-${i.status}`}>
                  <td data-label="Название">
                    <Link to={`/instances/${i.id}`} className="inst-name mono" title={i.name}>
                      {i.name}
                    </Link>
                    {i.owner && <div className="muted small">{i.owner.email}</div>}
                  </td>
                  <td data-label="Статус">
                    <StatusBadge status={i.status} />
                  </td>
                  <td data-label="GPU">
                    <span className="nowrap">
                      {i.gpuModel} × {i.gpuCount}
                    </span>
                    <div>
                      <span className="code-chip mono">{i.datacenter.code}</span>
                    </div>
                  </td>
                  <td data-label="Тариф">
                    <PricingBadge type={i.pricingType} />
                  </td>
                  <td data-label="Цена" className="num mono">
                    {formatMoney(i.pricePerHour)}
                  </td>
                  <td data-label="Сеанс">
                    <span className="nowrap">
                      <Runtime instance={i} />
                    </span>
                    <div className="muted small mono nowrap">
                      <SessionCost instance={i} />
                    </div>
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

import { Link, useNavigate, useParams } from 'react-router-dom';
import { useInstance } from '../api/hooks';
import { ApiError } from '../api/client';
import { IconArrowLeft } from '../components/icons';
import { InstanceActions } from '../components/InstanceActions';
import { Runtime, SessionCost } from '../components/Runtime';
import { PageHead, PricingBadge, QueryState, StatusBadge } from '../components/ui';
import { HOURS_IN_DAY } from '../lib/cost';
import { formatDateTime, formatMoney, toNumber } from '../lib/format';

export function InstanceDetailPage() {
  const { id = '' } = useParams();
  const instance = useInstance(id);
  const navigate = useNavigate();
  const i = instance.data;

  if (instance.error instanceof ApiError && instance.error.status === 404) {
    return (
      <div className="empty">
        <p className="empty-title">Инстанс не найден</p>
        <p>
          <Link to="/instances">К списку инстансов</Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="crumbs">
        <Link to="/instances" className="crumb-link">
          <IconArrowLeft size={16} />
          Инстансы
        </Link>
      </p>
      <QueryState isLoading={instance.isLoading} error={instance.error} onRetry={() => void instance.refetch()} />
      {i && (
        <>
          <PageHead title={i.name}>
            <StatusBadge status={i.status} />
            <InstanceActions instance={i} onDone={(a) => a === 'terminate' && navigate('/instances')} />
          </PageHead>

          <div className="grid-2">
            <section className="card">
              <h2>Конфигурация</h2>
              <dl className="kv">
                <dt>Идентификатор</dt>
                <dd className="mono small break">{i.id}</dd>
                <dt>Дата-центр</dt>
                <dd>
                  {i.datacenter.name} <span className="code-chip mono">{i.datacenter.code}</span>
                </dd>
                <dt>GPU</dt>
                <dd>
                  {i.gpuModel} × {i.gpuCount}
                </dd>
                <dt>Тариф</dt>
                <dd>
                  <PricingBadge type={i.pricingType} />
                </dd>
                <dt>Шаблон</dt>
                <dd>{i.template?.name ?? '—'}</dd>
                <dt>Диск контейнера</dt>
                <dd className="mono">{i.containerDiskGb} ГБ</dd>
                <dt>Сетевой том</dt>
                <dd>{i.volume ? `${i.volume.name} (${i.volume.sizeGb} ГБ)` : '—'}</dd>
                <dt>SSH-ключ</dt>
                <dd>{i.sshKey?.name ?? '—'}</dd>
              </dl>
            </section>

            <section className="card">
              <h2>Стоимость и время</h2>
              <dl className="kv">
                <dt>Цена за час</dt>
                <dd>
                  <strong className="mono">{formatMoney(i.pricePerHour)}</strong>
                  <div className="muted small">зафиксирована при запуске</div>
                </dd>
                <dt>Цена за сутки</dt>
                <dd className="mono">{formatMoney(toNumber(i.pricePerHour) * HOURS_IN_DAY)}</dd>
                <dt>Время работы сеанса</dt>
                <dd className="mono">
                  <Runtime instance={i} />
                </dd>
                <dt>Стоимость сеанса</dt>
                <dd className="mono">
                  <SessionCost instance={i} />
                </dd>
                <dt>Создан</dt>
                <dd>{formatDateTime(i.createdAt)}</dd>
                <dt>Запущен</dt>
                <dd>{formatDateTime(i.startedAt)}</dd>
                <dt>Остановлен</dt>
                <dd>{formatDateTime(i.stoppedAt)}</dd>
                {i.terminatedAt && (
                  <>
                    <dt>Удалён</dt>
                    <dd>{formatDateTime(i.terminatedAt)}</dd>
                  </>
                )}
              </dl>
              <p className="muted small section-note">
                Списания по этому инстансу — в <Link to="/billing">истории операций</Link>.
              </p>
            </section>
          </div>
        </>
      )}
    </>
  );
}

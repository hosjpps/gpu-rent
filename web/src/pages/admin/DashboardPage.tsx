import { useMemo } from 'react';
import { useDashboard } from '../../api/hooks';
import { BarChart } from '../../components/BarChart';
import { IconChart, IconClock } from '../../components/icons';
import { QueryState } from '../../components/ui';
import { formatDate, formatMoney, pad, toNumber } from '../../lib/format';

export default function DashboardPage() {
  const dash = useDashboard();
  const d = dash.data;

  const days = useMemo(
    () =>
      (d?.revenueByDay ?? []).map((r) => {
        const date = new Date(`${r.day.slice(0, 10)}T00:00:00`);
        return {
          label: `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`,
          title: formatDate(r.day.slice(0, 10)),
          value: toNumber(r.revenue),
        };
      }),
    [d],
  );

  if (!d) return <QueryState isLoading={dash.isLoading} error={dash.error} onRetry={() => void dash.refetch()} />;

  const totalRevenue = d.revenueByDay.reduce((s, r) => s + toNumber(r.revenue), 0);
  const totalHours = d.revenueByDay.reduce((s, r) => s + toNumber(r.gpuHours), 0);
  const u = d.utilization;
  const usable = u.total - u.disabled;
  const busyShare = usable > 0 ? Math.round((u.busy / usable) * 100) : 0;
  const maxDc = Math.max(1, ...d.revenueByDatacenter.map((r) => toNumber(r.revenue)));
  const maxModel = Math.max(1, ...d.revenueByModel.map((r) => toNumber(r.revenue)));

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="stat-icon" aria-hidden="true">
            <IconChart />
          </span>
          <span className="stat-label">Выручка от GPU за период</span>
          <span className="stat-value mono" data-testid="revenue-total">
            {formatMoney(totalRevenue)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon" aria-hidden="true">
            <IconClock />
          </span>
          <span className="stat-label">GPU-часов</span>
          <span className="stat-value mono">{Math.round(totalHours).toLocaleString('ru-RU')}</span>
        </div>
        <div className="stat stat-ring">
          <Ring share={busyShare} />
          <span className="stat-ring-text">
            <span className="stat-label">Загрузка GPU</span>
            <span className="stat-value mono">{busyShare}%</span>
            <span className="muted small">
              занято {u.busy} из {usable} доступных
            </span>
          </span>
        </div>
      </div>

      <section className="card section">
        <h2>Выручка от GPU по дням</h2>
        <BarChart data={days} format={formatMoney} ariaLabel="Выручка от GPU по дням" valueTitle="Выручка" />
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>По дата-центрам</h2>
          <ul className="meter-list">
            {d.revenueByDatacenter.map((r) => (
              <li key={r.code}>
                <div className="meter-head">
                  <span>{r.name}</span>
                  <strong className="mono">{formatMoney(r.revenue)}</strong>
                </div>
                <progress className="meter" value={toNumber(r.revenue)} max={maxDc} aria-label={r.name} />
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2>По моделям GPU</h2>
          <ul className="meter-list">
            {d.revenueByModel.map((r) => (
              <li key={r.name}>
                <div className="meter-head">
                  <span>{r.name}</span>
                  <strong className="mono">{formatMoney(r.revenue)}</strong>
                </div>
                <progress className="meter" value={toNumber(r.revenue)} max={maxModel} aria-label={r.name} />
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="muted small">Данные витрины обновляются при проходе биллинга и могут отставать до 30 минут, а если биллинг по расписанию не настроен — до суток. Хранение томов в выручку не входит.</p>
    </>
  );
}

/** Кольцо загрузки: доля занятых GPU среди доступных */
function Ring({ share }: { share: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const value = Math.min(100, Math.max(0, share));
  return (
    <svg className="ring" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
      <circle className="ring-track" cx="32" cy="32" r={r} strokeWidth="7" fill="none" />
      <circle
        className="ring-value"
        cx="32"
        cy="32"
        r={r}
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${(value / 100) * c} ${c}`}
        transform="rotate(-90 32 32)"
      />
    </svg>
  );
}

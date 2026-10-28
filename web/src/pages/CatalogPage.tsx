import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCatalog, useMe, useMyTemplates, useTemplates } from '../api/hooks';
import type { GpuOffer, PricingType, Template } from '../api/types';
import { LaunchDialog, type LaunchPreset } from '../components/LaunchDialog';
import { Empty, PageHead, QueryState } from '../components/ui';
import { formatMoney } from '../lib/format';

type Tab = 'gpu' | 'templates';

export function CatalogPage() {
  const [tab, setTab] = useState<Tab>('gpu');
  return (
    <>
      <PageHead title="Каталог" />
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'gpu'} className={tab === 'gpu' ? 'tab active' : 'tab'} onClick={() => setTab('gpu')}>
          GPU по дата-центрам
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'templates'}
          className={tab === 'templates' ? 'tab active' : 'tab'}
          onClick={() => setTab('templates')}
        >
          Шаблоны
        </button>
      </div>
      {tab === 'gpu' ? <GpuCatalog /> : <TemplateList />}
    </>
  );
}

function GpuCatalog() {
  const catalog = useCatalog();
  const me = useMe().data;
  const navigate = useNavigate();
  const location = useLocation();
  const [dc, setDc] = useState('');
  const [model, setModel] = useState('');
  const [onlyFree, setOnlyFree] = useState(false);
  const [preset, setPreset] = useState<LaunchPreset | null>(null);

  const offers = catalog.data ?? [];
  const dcs = useMemo(() => uniq(offers.map((o): Pair => [o.datacenter.code, `${o.datacenter.city} · ${o.datacenter.code}`])), [offers]);
  const models = useMemo(() => uniq(offers.map((o): Pair => [o.model.name, o.model.name])), [offers]);

  const filtered = offers.filter(
    (o) => (!dc || o.datacenter.code === dc) && (!model || o.model.name === model) && (!onlyFree || o.free > 0),
  );
  const groups = useMemo(() => {
    const map = new Map<string, GpuOffer[]>();
    for (const o of filtered) map.set(o.datacenter.code, [...(map.get(o.datacenter.code) ?? []), o]);
    return [...map.values()];
  }, [filtered]);

  function start(offer: GpuOffer, pricingType: PricingType) {
    if (!me) {
      navigate('/login', { state: { from: location.pathname } });
      return;
    }
    setPreset({ datacenterCode: offer.datacenter.code, gpuModel: offer.model.name, pricingType });
  }

  return (
    <>
      <div className="filters">
        <label className="field">
          <span className="field-label">Дата-центр</span>
          <select value={dc} onChange={(e) => setDc(e.target.value)} aria-label="Фильтр по дата-центру">
            <option value="">Все</option>
            {dcs.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Модель</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Фильтр по модели">
            <option value="">Все</option>
            {models.map(([name]) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
          Только со свободными GPU
        </label>
      </div>

      <QueryState isLoading={catalog.isLoading} error={catalog.error} onRetry={() => void catalog.refetch()} />

      {catalog.data && groups.length === 0 && <Empty title="Ничего не найдено">Измените фильтры.</Empty>}

      {groups.map((rows) => {
        const first = rows[0];
        if (!first) return null;
        return (
          <section key={first.datacenter.code} className="card section" aria-label={first.datacenter.name}>
            <h2>
              {first.datacenter.name} <span className="muted">· {first.datacenter.code}</span>
            </h2>
            <table className="table responsive catalog" data-testid="gpu-table">
              <thead>
                <tr>
                  <th>Модель</th>
                  <th>Память</th>
                  <th>Свободно</th>
                  <th className="num">Обычный, ₽/ч</th>
                  <th className="num">Spot, ₽/ч</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.model.name}>
                    <td data-label="Модель">
                      <strong>{o.model.name}</strong>
                    </td>
                    <td data-label="Память">{o.model.vramGb} ГБ</td>
                    <td data-label="Свободно">
                      <Availability free={o.free} total={o.total} />
                    </td>
                    <td data-label="Обычный" className="num">
                      {o.priceOnDemand ? formatMoney(o.priceOnDemand) : '—'}
                    </td>
                    <td data-label="Spot" className="num">
                      {o.priceSpot ? formatMoney(o.priceSpot) : '—'}
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={o.free === 0 || (!o.priceOnDemand && !o.priceSpot)}
                        onClick={() => start(o, o.priceOnDemand ? 'on_demand' : 'spot')}
                        aria-label={`Запустить ${o.model.name} в ${o.datacenter.code}`}
                      >
                        Запустить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {preset && <LaunchDialog offers={offers} preset={preset} onClose={() => setPreset(null)} />}
    </>
  );
}

type Pair = [value: string, label: string];

function uniq(pairs: Pair[]): Pair[] {
  return [...new Map(pairs).entries()];
}

function Availability({ free, total }: { free: number; total: number }) {
  const share = total > 0 ? free / total : 0;
  const level = free === 0 ? 'none' : share < 0.25 ? 'low' : 'ok';
  return (
    <div className="avail">
      <span className={`avail-num avail-${level}`}>
        {free} <span className="muted">из {total}</span>
      </span>
      <progress className={`avail-bar avail-${level}`} value={free} max={Math.max(total, 1)} aria-label={`Свободно ${free} из ${total}`} />
    </div>
  );
}

function TemplateList() {
  const me = useMe().data;
  const pub = useTemplates();
  const mine = useMyTemplates(!!me);
  const list: Template[] = [...(pub.data ?? []), ...(mine.data ?? [])];

  return (
    <>
      <QueryState isLoading={pub.isLoading} error={pub.error ?? mine.error} onRetry={() => void pub.refetch()} />
      {pub.data && list.length === 0 && <Empty title="Шаблонов пока нет" />}
      <div className="card-grid">
        {list.map((t) => (
          <article key={t.id} className="card">
            <h3>
              {t.name} {!t.isPublic && <span className="badge badge-spot">мой</span>}
            </h3>
            <p className="mono small break">{t.dockerImage}</p>
            <dl className="kv">
              <dt>Диск по умолчанию</dt>
              <dd>{t.defaultDiskGb} ГБ</dd>
              <dt>Порты</dt>
              <dd className="mono">{t.defaultPorts || '—'}</dd>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}

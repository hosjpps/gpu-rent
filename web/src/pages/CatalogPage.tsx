import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCatalog, useMe, useMyTemplates, useTemplates } from '../api/hooks';
import type { GpuOffer, PricingType, Template } from '../api/types';
import { IconChip, IconLayers, IconPlay } from '../components/icons';
import { LaunchDialog, type LaunchPreset } from '../components/LaunchDialog';
import { CopyChip, Empty, QueryState } from '../components/ui';
import { formatMoney, toNumber } from '../lib/format';

type Tab = 'gpu' | 'templates';

export function CatalogPage() {
  const [tab, setTab] = useState<Tab>('gpu');
  return (
    <>
      <CatalogHero />
      <div className="tabs tabs-seg" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'gpu'} className={tab === 'gpu' ? 'tab active' : 'tab'} onClick={() => setTab('gpu')}>
          <IconChip size={18} />
          GPU по дата-центрам
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'templates'}
          className={tab === 'templates' ? 'tab active' : 'tab'}
          onClick={() => setTab('templates')}
        >
          <IconLayers size={18} />
          Шаблоны
        </button>
      </div>
      {tab === 'gpu' ? <GpuCatalog /> : <TemplateList />}
    </>
  );
}

/** Шапка каталога: что это и три цифры, ради которых сюда приходят */
function CatalogHero() {
  const catalog = useCatalog();
  const offers = catalog.data ?? [];
  const free = offers.reduce((s, o) => s + o.free, 0);
  const total = offers.reduce((s, o) => s + o.total, 0);
  const dcCount = new Set(offers.map((o) => o.datacenter.code)).size;
  const prices = offers.flatMap((o) => [o.priceOnDemand, o.priceSpot]).filter((p): p is string => !!p).map(toNumber);
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;

  return (
    <header className="hero-band">
      <div className="hero-copy">
        <h1>Каталог</h1>
        <p className="hero-sub">
          Облачные GPU в российских дата-центрах. Контейнер из готового шаблона, оплата посекундная, остановить можно в
          любой момент.
        </p>
      </div>
      <dl className="hero-stats" aria-busy={catalog.isLoading}>
        <div className="hero-stat">
          <dt>Свободно GPU</dt>
          <dd className="mono">
            {catalog.data ? free : '—'}
            {catalog.data && <span className="hero-stat-of"> / {total}</span>}
          </dd>
        </div>
        <div className="hero-stat">
          <dt>Дата-центров</dt>
          <dd className="mono">{catalog.data ? dcCount : '—'}</dd>
        </div>
        <div className="hero-stat">
          <dt>Цена от</dt>
          <dd className="mono">
            {minPrice === null ? '—' : formatMoney(minPrice)}
            {minPrice !== null && <span className="hero-stat-of">/ч</span>}
          </dd>
        </div>
      </dl>
    </header>
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
  const dcs = useMemo(() => uniq(offers.map((o): Pair => [o.datacenter.code, o.datacenter.city])), [offers]);
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
      <div className="filter-bar">
        <ChipGroup label="Дата-центр" value={dc} onChange={setDc} options={dcs} code />
        <ChipGroup label="Модель" value={model} onChange={setModel} options={models} />
        <label className="switch">
          <input type="checkbox" role="switch" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          Только со свободными GPU
        </label>
      </div>

      <QueryState isLoading={catalog.isLoading} error={catalog.error} onRetry={() => void catalog.refetch()} />

      {catalog.data && groups.length === 0 && (
        <Empty
          title="Ничего не найдено"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDc('');
                setModel('');
                setOnlyFree(false);
              }}
            >
              Сбросить фильтры
            </button>
          }
        >
          Под эти фильтры нет предложений.
        </Empty>
      )}

      {groups.map((rows) => {
        const first = rows[0];
        if (!first) return null;
        const free = rows.reduce((s, o) => s + o.free, 0);
        const total = rows.reduce((s, o) => s + o.total, 0);
        return (
          <section key={first.datacenter.code} className="dc-section" aria-label={first.datacenter.name}>
            <div className="dc-head">
              <h2>{first.datacenter.name}</h2>
              <span className="code-chip mono">{first.datacenter.code}</span>
              <span className="dc-free muted small">
                свободно <span className="mono">{free}</span> из <span className="mono">{total}</span>
              </span>
            </div>
            <div className="gpu-grid" data-testid="gpu-table">
              {rows.map((o) => {
                const canLaunch = o.free > 0 && (!!o.priceOnDemand || !!o.priceSpot);
                return (
                  <article key={o.model.name} className={o.free === 0 ? 'gpu-card is-full' : 'gpu-card'}>
                    <div className="gpu-card-head">
                      <h3>{o.model.name}</h3>
                      <span className="vram-chip mono">{o.model.vramGb} ГБ</span>
                    </div>
                    <Availability free={o.free} total={o.total} />
                    <div className="price-pair">
                      <div className="price">
                        <span className="price-label">Обычный</span>
                        <span className="price-value mono">
                          {o.priceOnDemand ? formatMoney(o.priceOnDemand) : '—'}
                          {o.priceOnDemand && <span className="price-unit">/ч</span>}
                        </span>
                      </div>
                      <div className="price price-spot">
                        <span className="price-label">Spot</span>
                        <span className="price-value mono">
                          {o.priceSpot ? formatMoney(o.priceSpot) : '—'}
                          {o.priceSpot && <span className="price-unit">/ч</span>}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      disabled={!canLaunch}
                      onClick={() => start(o, o.priceOnDemand ? 'on_demand' : 'spot')}
                      aria-label={`Запустить ${o.model.name} в ${o.datacenter.code}`}
                    >
                      <IconPlay size={16} />
                      Запустить
                    </button>
                  </article>
                );
              })}
            </div>
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

function ChipGroup({
  label,
  value,
  onChange,
  options,
  code,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Pair[];
  code?: boolean;
}) {
  return (
    <div className="chip-group" role="group" aria-label={`Фильтр: ${label.toLowerCase()}`}>
      <span className="chip-group-label" aria-hidden="true">
        {label}
      </span>
      <div className="chips">
        <button type="button" className="chip" aria-pressed={value === ''} onClick={() => onChange('')}>
          Все
        </button>
        {options.map(([v, text]) => (
          <button type="button" key={v} className="chip" aria-pressed={value === v} onClick={() => onChange(v)}>
            {text}
            {code && <span className="chip-code mono">{v}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// Свободные GPU как ячейки кристалла: по одной на карту. Для очень больших пулов — сплошная шкала.
const MAX_CELLS = 24;

function Availability({ free, total }: { free: number; total: number }) {
  const share = total > 0 ? free / total : 0;
  const level = free === 0 ? 'none' : share < 0.25 ? 'low' : 'ok';
  return (
    <div className={`avail avail-${level}`}>
      {total <= MAX_CELLS ? (
        <span className="die" role="img" aria-label={`Свободно ${free} из ${total}`}>
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={i < free ? 'die-cell on' : 'die-cell'} />
          ))}
        </span>
      ) : (
        <progress className="avail-bar" value={free} max={Math.max(total, 1)} aria-label={`Свободно ${free} из ${total}`} />
      )}
      <span className="avail-text">
        {free === 0 ? (
          'Нет свободных'
        ) : (
          <>
            <span className="mono avail-num">{free}</span> из <span className="mono">{total}</span> свободно
          </>
        )}
      </span>
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
      <div className="template-grid">
        {list.map((t) => {
          const ports = t.defaultPorts
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
          return (
            <article key={t.id} className="template-card">
              <div className="template-head">
                <span className="template-icon" aria-hidden="true">
                  <IconLayers size={20} />
                </span>
                <h3>{t.name}</h3>
                {!t.isPublic && <span className="badge badge-spot">мой</span>}
              </div>
              <CopyChip text={t.dockerImage} what="образ" />
              <dl className="spec-list">
                <div className="spec">
                  <dt>Диск по умолчанию</dt>
                  <dd className="mono">{t.defaultDiskGb} ГБ</dd>
                </div>
                <div className="spec">
                  <dt>Порты</dt>
                  <dd>
                    {ports.length === 0 ? (
                      '—'
                    ) : (
                      <span className="port-list">
                        {ports.map((p) => (
                          <span key={p} className="port mono">
                            {p}
                          </span>
                        ))}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </>
  );
}

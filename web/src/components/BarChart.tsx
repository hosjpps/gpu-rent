import { useEffect, useId, useRef, useState } from 'react';

export interface Bar {
  /** Подпись на оси X (короткая) */
  label: string;
  /** Полная подпись для подсказки и таблицы */
  title: string;
  value: number;
}

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 44 };
const MAX_BAR = 24;

// Округление верхней границы оси до «круглого» числа: 1, 2, 5 * 10^n
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)} млн`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)} тыс`;
  return String(+n.toFixed(2));
}

/**
 * Столбчатая диаграмма на SVG без библиотек. Один ряд данных: одна легенда не нужна,
 * заголовок блока говорит, что показано. Те же значения доступны таблицей и подсказкой.
 */
export function BarChart({
  data,
  format,
  ariaLabel,
  valueTitle,
}: {
  data: Bar[];
  format: (n: number) => string;
  ariaLabel: string;
  valueTitle: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  // id градиента уникален на странице: графиков может быть несколько
  const gradId = `bar-g-${useId().replace(/:/g, '')}`;

  // Рисуем в реальных пикселях, чтобы подписи не сжимались на телефоне
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);

  if (data.length === 0) return <p className="muted">Нет данных за выбранный период.</p>;

  const top = niceMax(Math.max(...data.map((d) => d.value)));
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / data.length;
  const barW = Math.min(MAX_BAR, Math.max(2, band - 2)); // зазор между столбцами 2 px
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 64))));
  const hit = active !== null ? data[active] : undefined;

  return (
    <div className="chart">
      <div className="row end">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTable((v) => !v)}>
          {table ? 'Показать график' : 'Показать таблицей'}
        </button>
      </div>
      {table ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Период</th>
                <th className="num">{valueTitle}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.title}>
                  <td>{d.title}</td>
                  <td className="num">{format(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-box" ref={box} onPointerLeave={() => setActive(null)}>
          <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="chart-stop-top" />
                <stop offset="1" className="chart-stop-bottom" />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="chart-tick" x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle">
                  {compact(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD.left + band * i + (band - barW) / 2;
              const h = (d.value / top) * plotH;
              const r = Math.min(4, barW / 2, h);
              const base = PAD.top + plotH;
              return (
                <g key={d.title}>
                  {h > 0 && (
                    // скругление 4 px только у вершины, основание прямое
                    <path
                      className={active === i ? 'chart-bar hot' : 'chart-bar'}
                      fill={`url(#${gradId})`}
                      d={`M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + barW - r} Q${x + barW},${base - h} ${x + barW},${base - h + r} V${base} Z`}
                    />
                  )}
                  {i % labelEvery === 0 && (
                    <text className="chart-tick" x={x + barW / 2} y={HEIGHT - 8} textAnchor="middle">
                      {d.label}
                    </text>
                  )}
                  {/* область наведения шире самого столбца и на всю высоту */}
                  <rect
                    className="chart-hit"
                    x={PAD.left + band * i}
                    y={PAD.top}
                    width={band}
                    height={plotH}
                    tabIndex={0}
                    aria-label={`${d.title}: ${format(d.value)}`}
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  />
                </g>
              );
            })}
          </svg>
          {hit && active !== null && (
            <div
              className="chart-tip"
              role="status"
              // подсказка у столбца, но не выходит за края
              ref={(el) => {
                if (!el) return;
                const cx = PAD.left + band * active + band / 2;
                const w = el.offsetWidth;
                el.style.left = `${Math.min(Math.max(cx - w / 2, 0), width - w)}px`;
                el.style.top = `${Math.max(y(hit.value) - el.offsetHeight - 8, 0)}px`;
              }}
            >
              <strong>{format(hit.value)}</strong>
              <span>{hit.title}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

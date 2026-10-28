import { useState, type FormEvent } from 'react';
import { useCatalog, usePrices, useSetPrice } from '../../api/hooks';
import type { PricingType } from '../../api/types';
import { ErrorNote } from '../../components/ErrorNote';
import { useToast } from '../../components/Toast';
import { Field, PricingBadge, QueryState } from '../../components/ui';
import { formatDateTime, formatMoneyPrecise } from '../../lib/format';

export default function PricesPage() {
  const prices = usePrices();
  const catalog = useCatalog();
  const setPrice = useSetPrice();
  const toast = useToast();
  const [onlyActive, setOnlyActive] = useState(true);

  const offers = catalog.data ?? [];
  const dcs = [...new Map(offers.map((o) => [o.datacenter.code, o.datacenter] as const)).values()];
  const models = [...new Set(offers.map((o) => o.model.name))];

  const [dc, setDc] = useState('');
  const [model, setModel] = useState('');
  const [type, setType] = useState<PricingType>('on_demand');
  const [price, setPriceValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dcValue = dc || dcs[0]?.code || '';
  const modelValue = model || models[0] || '';

  const rows = (prices.data ?? []).filter((p) => !onlyActive || p.validTo === null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = Number(price.replace(',', '.'));
    if (!price.trim() || !Number.isFinite(n) || n <= 0) {
      setError('Введите цену числом больше нуля');
      return;
    }
    if (n >= 100000) {
      setError('Цена за час должна быть меньше 100 000 ₽');
      return;
    }
    setError(null);
    setPrice.mutate(
      { datacenterCode: dcValue, gpuModel: modelValue, pricingType: type, pricePerHour: n },
      {
        onSuccess: () => {
          toast('Новая цена действует, прежняя закрыта');
          setPriceValue('');
        },
      },
    );
  }

  return (
    <>
      <section className="card section">
        <h2>Новая цена</h2>
        <p className="muted small">
          Прежняя цена закрывается в момент вступления новой. Уже запущенные инстансы платят по цене, зафиксированной
          при запуске.
        </p>
        <form className="price-form" onSubmit={submit} noValidate>
          <Field label="Дата-центр">
            <select name="datacenter" value={dcValue} onChange={(e) => setDc(e.target.value)}>
              {dcs.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.code} · {d.city}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Модель GPU">
            <select name="model" value={modelValue} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Тариф">
            <select name="pricingType" value={type} onChange={(e) => setType(e.target.value as PricingType)}>
              <option value="on_demand">Обычный</option>
              <option value="spot">Spot</option>
            </select>
          </Field>
          <Field label="Цена за GPU в час, ₽" error={error}>
            <input name="pricePerHour" inputMode="decimal" value={price} onChange={(e) => setPriceValue(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-primary" disabled={setPrice.isPending}>
            {setPrice.isPending ? 'Сохраняем…' : 'Установить цену'}
          </button>
        </form>
        <ErrorNote error={setPrice.error} />
      </section>

      <section className="card section">
        <div className="section-head">
          <h2>История цен</h2>
          <label className="check">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
            Только действующие
          </label>
        </div>
        <QueryState isLoading={prices.isLoading} error={prices.error} onRetry={() => void prices.refetch()} />
        {prices.data && (
          <div className="table-scroll">
            <table className="table responsive" data-testid="prices-table">
              <thead>
                <tr>
                  <th>ДЦ</th>
                  <th>Модель</th>
                  <th>Тариф</th>
                  <th className="num">Цена, ₽/ч</th>
                  <th>С</th>
                  <th>По</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td data-label="ДЦ">{p.datacenter.code}</td>
                    <td data-label="Модель">{p.gpuModel}</td>
                    <td data-label="Тариф">
                      <PricingBadge type={p.pricingType} />
                    </td>
                    <td data-label="Цена" className="num">
                      {formatMoneyPrecise(p.pricePerHour)}
                    </td>
                    <td data-label="С">{formatDateTime(p.validFrom)}</td>
                    <td data-label="По">{p.validTo ? formatDateTime(p.validTo) : <span className="badge badge-running">действует</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// Расчёт стоимости на клиенте: только подсказка в форме запуска.
// Итоговая цена фиксируется сервером (снимок цены на момент запуска).
import type { GpuOffer, PricingType } from '../api/types';
import { toNumber } from './format';

export function pricePerGpu(offer: Pick<GpuOffer, 'priceOnDemand' | 'priceSpot'>, type: PricingType): number | null {
  const raw = type === 'spot' ? offer.priceSpot : offer.priceOnDemand;
  return raw === null ? null : toNumber(raw);
}

/**
 * Стоимость часа работы инстанса: цена одной GPU * число GPU, округление до копеек вверх (с запасом).
 * Считаем в целых десятитысячных рубля (как numeric(…, 4) в БД): умножение float на 100 даёт шум
 * IEEE-754 (74.93 * 100 = 7493.000000000001) и лишнюю копейку.
 */
export function hourlyCost(priceOfOneGpu: number | null, gpuCount: number): number | null {
  if (priceOfOneGpu === null) return null;
  const units = Math.round(priceOfOneGpu * 10000) * gpuCount;
  return Math.ceil(units / 100) / 100;
}

export const HOURS_IN_DAY = 24;
export const HOURS_IN_MONTH = 24 * 30;

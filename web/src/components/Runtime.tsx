import type { Instance } from '../api/types';
import { formatDuration, formatMoney, toNumber } from '../lib/format';
import { useNow } from './ui';

/** Границы текущего сеанса в мс: у работающего конец «сейчас», у остановленного — момент остановки */
function useSession(instance: Instance): number | null {
  const running = instance.status === 'running';
  const now = useNow(running);
  if (!instance.startedAt) return null;
  const start = new Date(instance.startedAt).getTime();
  const endIso = instance.stoppedAt ?? instance.terminatedAt;
  const end = running ? now : endIso ? new Date(endIso).getTime() : null;
  return end === null ? null : end - start;
}

/** Время работы текущего сеанса: идёт у работающего, зафиксировано у остановленного */
export function Runtime({ instance }: { instance: Instance }) {
  const ms = useSession(instance);
  return <>{ms === null ? '—' : formatDuration(ms)}</>;
}

/**
 * Оценка стоимости сеанса для интерфейса: цена часа × длительность.
 * Точные списания (с учётом тома и округлений биллинга) — в истории операций.
 */
export function SessionCost({ instance }: { instance: Instance }) {
  const ms = useSession(instance);
  if (ms === null) return <>—</>;
  return <>≈ {formatMoney((toNumber(instance.pricePerHour) * Math.max(0, ms)) / 3_600_000)}</>;
}

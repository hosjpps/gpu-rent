// Форматирование денег, дат и длительностей для интерфейса.

const money = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Для мелких сумм (цена секунды, списания) нужны 4 знака, как в БД
const moneyPrecise = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

export function toNumber(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return money.format(toNumber(value));
}

export function formatMoneyPrecise(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return moneyPrecise.format(toNumber(value));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateTime.format(d);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  // "2026-10-28" без времени: разбираем вручную, чтобы часовой пояс не сдвинул день
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : dateOnly.format(d);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} д ${hours} ч ${minutes} мин`;
  if (hours > 0) return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
  if (minutes > 0) return `${minutes} мин ${String(seconds).padStart(2, '0')} с`;
  return `${seconds} с`;
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Дата в формате YYYY-MM-DD по местному времени (для полей <input type="date"> и запросов) */
export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Запускается',
  running: 'Работает',
  stopped: 'Остановлен',
  terminated: 'Удалён',
  failed: 'Ошибка',
};

export const PRICING_LABEL: Record<string, string> = {
  on_demand: 'Обычный',
  spot: 'Spot',
};

export const TX_LABEL: Record<string, string> = {
  topup: 'Пополнение',
  charge: 'Списание',
  refund: 'Возврат',
  bonus: 'Бонус',
  adjustment: 'Корректировка',
};

export const NODE_STATUS_LABEL: Record<string, string> = {
  online: 'В работе',
  maintenance: 'Обслуживание',
  offline: 'Выключена',
};

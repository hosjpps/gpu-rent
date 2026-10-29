import { useEffect, useState, type ReactNode } from 'react';
import { PRICING_LABEL, STATUS_LABEL } from '../lib/format';
import type { InstanceStatus, PricingType } from '../api/types';
import { ErrorNote } from './ErrorNote';
import { IconCheck, IconCopy, IconInbox } from './icons';

export function Spinner({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

/** Заглушка на время загрузки: повторяет ритм будущего содержимого, чтобы страница не прыгала */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" role="status">
      <span className="sr-only">Загрузка…</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-row" aria-hidden="true">
          <span className="skeleton-bar w-30" />
          <span className="skeleton-bar w-60" />
          <span className="skeleton-bar w-15" />
        </span>
      ))}
    </div>
  );
}

export function Empty({
  title,
  children,
  icon,
  action,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        {icon ?? <IconInbox size={28} />}
      </span>
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function QueryState({
  isLoading,
  error,
  onRetry,
}: {
  isLoading: boolean;
  error: unknown;
  onRetry?: () => void;
}) {
  if (isLoading) return <Skeleton />;
  if (!error) return null;
  return (
    <div className="stack">
      <ErrorNote error={error} />
      {onRetry && (
        <div>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Повторить
          </button>
        </div>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: InstanceStatus }) {
  return (
    <span className={`badge status badge-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function PricingBadge({ type }: { type: PricingType }) {
  return <span className={`badge badge-${type}`}>{PRICING_LABEL[type] ?? type}</span>;
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  // Подсказка и ошибка стоят вне <label>: иначе они попадают в доступное имя поля («Пароль Не короче 8 символов»)
  return (
    <div className="field">
      <label>
        <span className="field-label">{label}</span>
        {children}
      </label>
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function useCopy(text: string) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      // Буфер недоступен (не HTTPS, запрет браузера): пусть пользователь выделит текст сам
      setState('failed');
    }
  }
  return { state, copy };
}

export function CopyButton({ text, label = 'Копировать' }: { text: string; label?: string }) {
  const { state, copy } = useCopy(text);
  return (
    <button type="button" className="btn btn-sm" onClick={copy}>
      {state === 'done' ? <IconCheck size={16} /> : <IconCopy size={16} />}
      {state === 'done' ? 'Скопировано' : state === 'failed' ? 'Не удалось, выделите вручную' : label}
    </button>
  );
}

/** Значение моноширинным «чипом»: длинное обрезается многоточием, полный текст в подсказке, клик копирует */
export function CopyChip({ text, what }: { text: string; what: string }) {
  const { state, copy } = useCopy(text);
  const hint = state === 'done' ? 'Скопировано' : state === 'failed' ? 'Не удалось скопировать' : `Скопировать ${what}`;
  return (
    <button type="button" className="copy-chip" onClick={copy} title={text} aria-label={`${hint}: ${text}`}>
      <span className="copy-chip-text">{text}</span>
      <span className="copy-chip-icon" aria-hidden="true">
        {state === 'done' ? <IconCheck size={15} /> : <IconCopy size={15} />}
      </span>
    </button>
  );
}

/** Секунды-тикер для живого «времени работы» */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

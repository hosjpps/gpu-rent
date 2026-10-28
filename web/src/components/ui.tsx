import { useEffect, useState, type ReactNode } from 'react';
import { PRICING_LABEL, STATUS_LABEL } from '../lib/format';
import type { InstanceStatus, PricingType } from '../api/types';
import { ErrorNote } from './ErrorNote';

export function Spinner({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
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
  if (isLoading) return <Spinner />;
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
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function PricingBadge({ type }: { type: PricingType }) {
  return <span className={`badge badge-${type}`}>{PRICING_LABEL[type] ?? type}</span>;
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children && <div className="row">{children}</div>}
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

export function CopyButton({ text, label = 'Копировать' }: { text: string; label?: string }) {
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
  return (
    <button type="button" className="btn btn-sm" onClick={copy}>
      {state === 'done' ? 'Скопировано' : state === 'failed' ? 'Не удалось, выделите вручную' : label}
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

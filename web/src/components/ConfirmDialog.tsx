import type { ReactNode } from 'react';
import { Dialog } from './Dialog';
import { ErrorNote } from './ErrorNote';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmText: string;
  danger?: boolean;
  pending?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmText,
  danger,
  pending,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <div className="stack">
        <div>{children}</div>
        <ErrorNote error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onCancel} disabled={pending}>
            Отмена
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? 'Подождите…' : confirmText}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

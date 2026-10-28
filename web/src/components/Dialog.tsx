import { useEffect, useRef, type ReactNode } from 'react';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

// Системный <dialog>: фокус остаётся внутри окна, Esc закрывает, фон под окном недоступен
export function Dialog({ title, onClose, children, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  // Закрывать окно в cleanup нельзя: событие close вернулось бы в onClose (в StrictMode — сразу после открытия).
  // Размонтированный <dialog> браузер закрывает сам.
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog-wide' : 'dialog'}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onClick={(e) => {
        // клик по затемнению (сам <dialog>, а не его содержимое)
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id="dialog-title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

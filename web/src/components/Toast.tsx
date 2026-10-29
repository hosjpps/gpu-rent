import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconCheck } from './icons';

interface ToastItem {
  id: number;
  text: string;
}

const ToastContext = createContext<(text: string) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((text: string) => {
    const id = nextId.current++;
    setItems((list) => [...list, { id, text }]);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDone={() => setItems((list) => list.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="toast">
      <span className="toast-icon" aria-hidden="true">
        <IconCheck size={16} />
      </span>
      {item.text}
    </div>
  );
}

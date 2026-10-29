import { useSyncExternalStore } from 'react';
import { IconMoon, IconSun } from './icons';

type Theme = 'light' | 'dark';
const KEY = 'gpu-rent-theme';
const DARK_MQ = '(prefers-color-scheme: dark)';

// Хранилище может быть недоступно (приватный режим, запрет cookie): тогда просто следуем системной теме
function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // выбор не сохранится между визитами, но в текущей вкладке тема переключится
  }
}

/**
 * Явный выбор пользователя ставим атрибутом data-theme на <html>. Без выбора атрибута нет,
 * и тему задаёт CSS по prefers-color-scheme (в том числе до загрузки скрипта).
 * Встроенный скрипт в index.html запрещён CSP, поэтому вызываем до первого рендера из main.tsx.
 */
export function applyStoredTheme() {
  const stored = readStored();
  if (stored) document.documentElement.dataset.theme = stored;
}

function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia(DARK_MQ).matches ? 'dark' : 'light';
}

// Переключателей на странице два (верхняя панель телефона и боковая панель): оба читают тему из <html>
function subscribe(onChange: () => void) {
  const mq = window.matchMedia(DARK_MQ);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  mq.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    mq.removeEventListener('change', onChange);
  };
}

export function ThemeToggle({ className = '' }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, currentTheme);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    writeStored(next);
  }

  const label = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
  return (
    <button type="button" className={`icon-btn theme-toggle ${className}`.trim()} onClick={toggle} aria-label={label} title={label}>
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

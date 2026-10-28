// Проверки полей форм на клиенте. Сервер проверяет всё повторно: это только быстрая обратная связь.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateEmail(email: string): string | null {
  if (!email.trim()) return 'Введите email';
  if (!EMAIL_RE.test(email.trim())) return 'Похоже на неверный email';
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Введите пароль';
  if (password.length < 8) return 'Пароль не короче 8 символов';
  if (password.length > 72) return 'Пароль не длиннее 72 символов';
  return null;
}

export function validateName(name: string, what = 'Название'): string | null {
  const v = name.trim();
  if (!v) return `${what}: введите значение`;
  if (v.length > 64) return `${what}: не длиннее 64 символов`;
  return null;
}

export function validateEnvName(name: string): string | null {
  if (!name) return 'Введите имя переменной';
  if (!ENV_NAME_RE.test(name)) return 'Имя: латиница, цифры и «_», не с цифры';
  return null;
}

export function validateSshKey(key: string): string | null {
  const v = key.trim();
  if (!v) return 'Вставьте публичный ключ';
  if (!/^(ssh-|ecdsa-)/.test(v)) return 'Публичный ключ начинается с ssh-… или ecdsa-…';
  if (v.split(/\s+/).length < 2) return 'В ключе не хватает содержимого';
  return null;
}

export function validateAmount(raw: string): string | null {
  const n = Number(raw.replace(',', '.'));
  if (!raw.trim() || !Number.isFinite(n)) return 'Введите сумму числом';
  if (n < 10) return 'Минимальная сумма пополнения — 10 ₽';
  if (n > 1_000_000) return 'Максимальная сумма за раз — 1 000 000 ₽';
  return null;
}

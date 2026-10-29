import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useLogin, useRegister } from '../api/hooks';
import { ErrorNote } from '../components/ErrorNote';
import { BrandMark, IconClock, IconLayers, IconTerminal } from '../components/icons';
import { Field } from '../components/ui';
import { validateEmail, validateName, validatePassword } from '../lib/validation';

interface LocationState {
  from?: string;
}

const PERKS = [
  { icon: <IconClock />, title: 'Посекундная оплата', text: 'Списываем ровно за время работы, остановили инстанс — счёт за GPU остановился.' },
  { icon: <IconLayers />, title: 'Шаблоны PyTorch и Jupyter', text: 'Готовые образы с драйверами и CUDA: выбрали шаблон, и контейнер готов к работе.' },
  { icon: <IconTerminal />, title: 'Тома и SSH', text: 'Сетевые тома хранят данные между запусками, доступ по своему SSH-ключу.' },
];

/** Экран входа и регистрации: слева о сервисе, справа форма (на телефоне форма первой) */
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-split">
      <div className="auth-card">{children}</div>
      <aside className="auth-brand" aria-label="О сервисе">
        <BrandMark size={40} />
        <p className="auth-brand-title">Видеокарты для обучения и инференса по цене минут, а не месяцев</p>
        <ul className="perks">
          {PERKS.map((p) => (
            <li key={p.title} className="perk">
              <span className="perk-icon" aria-hidden="true">
                {p.icon}
              </span>
              <span>
                <strong>{p.title}</strong>
                <span className="perk-text">{p.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const from = (useLocation().state as LocationState | null)?.from ?? '/instances';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null }>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = {
      email: validateEmail(email),
      password: password ? null : 'Введите пароль',
    };
    setErrors(next);
    if (next.email || next.password) return;
    login.mutate({ email: email.trim(), password }, { onSuccess: () => navigate(from, { replace: true }) });
  }

  return (
    <AuthShell>
      <h1>Вход</h1>
      <p className="muted auth-lead">Войдите, чтобы управлять инстансами, томами и балансом.</p>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Email" error={errors.email}>
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email}
          />
        </Field>
        <Field label="Пароль" error={errors.password}>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password}
          />
        </Field>
        <ErrorNote error={login.error} />
        <button type="submit" className="btn btn-primary btn-lg" disabled={login.isPending}>
          {login.isPending ? 'Входим…' : 'Войти'}
        </button>
      </form>
      <p className="muted auth-switch">
        Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
      </p>
    </AuthShell>
  );
}

export function RegisterPage() {
  const register = useRegister();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = {
      fullName: validateName(fullName, 'Имя'),
      email: validateEmail(email),
      password: validatePassword(password),
      repeat: password !== repeat ? 'Пароли не совпадают' : null,
    };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    register.mutate(
      { fullName: fullName.trim(), email: email.trim(), password },
      // Ссылку подтверждения (демо-режим) показываем в настройках
      { onSuccess: ({ verifyUrl }) => navigate('/settings', { replace: true, state: { verifyUrl } }) },
    );
  }

  return (
    <AuthShell>
      <h1>Регистрация</h1>
      <p className="muted auth-lead">Нужны только имя, email и пароль, карта при регистрации не требуется.</p>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Имя" error={errors.fullName}>
          <input
            name="fullName"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            aria-invalid={!!errors.fullName}
          />
        </Field>
        <Field label="Email" error={errors.email}>
          <input
            type="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email}
          />
        </Field>
        <Field label="Пароль" error={errors.password} hint="Не короче 8 символов">
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password}
          />
        </Field>
        <Field label="Повторите пароль" error={errors.repeat}>
          <input
            type="password"
            name="repeat"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            aria-invalid={!!errors.repeat}
          />
        </Field>
        <ErrorNote error={register.error} />
        <button type="submit" className="btn btn-primary btn-lg" disabled={register.isPending}>
          {register.isPending ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
        </button>
      </form>
      <p className="muted auth-switch">
        Уже есть аккаунт? <Link to="/login">Войти</Link>
      </p>
    </AuthShell>
  );
}

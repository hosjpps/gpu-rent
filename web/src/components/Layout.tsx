import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useBalance, useLogout, useMe } from '../api/hooks';
import { formatMoney, toNumber } from '../lib/format';
import {
  BrandMark,
  IconChip,
  IconClose,
  IconDisk,
  IconLogin,
  IconLogout,
  IconMenu,
  IconServer,
  IconSettings,
  IconShield,
  IconWallet,
} from './icons';
import { ThemeToggle } from './ThemeToggle';
import { Skeleton } from './ui';

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? 'nav-link active' : 'nav-link';
}

function NavItem({ to, end, icon, children }: { to: string; end?: boolean; icon: ReactNode; children: string }) {
  return (
    <NavLink to={to} end={end} className={navClass}>
      <span className="nav-icon">{icon}</span>
      {children}
    </NavLink>
  );
}

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="GPU Rent, главная">
      <BrandMark />
      <span className="brand-name">GPU Rent</span>
    </Link>
  );
}

export function Layout() {
  const me = useMe();
  const user = me.data;
  const balance = useBalance(!!user);
  const logout = useLogout();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // После перехода по ссылке меню на телефоне закрываем
  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const balanceValue = balance.data?.balance ?? user?.balance;
  const negative = balanceValue !== undefined && toNumber(balanceValue) < 0;
  const balanceClass = negative ? 'balance balance-neg' : 'balance';

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        К содержимому
      </a>

      {/* Верхняя панель только для узких экранов: на десктопе её роль играет боковая навигация */}
      <header className="mobilebar">
        <Brand />
        <div className="mobilebar-tools">
          {user && (
            <Link to="/billing" className={`${balanceClass} balance-chip mono`} title="Баланс">
              {formatMoney(balanceValue)}
            </Link>
          )}
          <ThemeToggle />
          <button
            type="button"
            className="icon-btn menu-btn"
            aria-expanded={open}
            aria-controls="main-nav"
            aria-label={open ? 'Закрыть меню' : 'Открыть меню'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <IconClose /> : <IconMenu />}
          </button>
        </div>
      </header>

      <aside id="main-nav" className={open ? 'sidebar open' : 'sidebar'}>
        <div className="sidebar-head">
          <Brand />
          <ThemeToggle className="desktop-only" />
        </div>

        <nav className="nav" aria-label="Основная навигация">
          <div className="nav-group">
            <NavItem to="/" end icon={<IconChip />}>
              Каталог
            </NavItem>
            {user && (
              <>
                <NavItem to="/instances" icon={<IconServer />}>
                  Инстансы
                </NavItem>
                <NavItem to="/volumes" icon={<IconDisk />}>
                  Тома
                </NavItem>
                <NavItem to="/billing" icon={<IconWallet />}>
                  Баланс
                </NavItem>
                <NavItem to="/settings" icon={<IconSettings />}>
                  Настройки
                </NavItem>
              </>
            )}
          </div>
          {user?.role === 'admin' && (
            <div className="nav-group">
              <span className="nav-group-label" aria-hidden="true">
                Управление
              </span>
              <NavItem to="/admin" icon={<IconShield />}>
                Админка
              </NavItem>
            </div>
          )}
        </nav>

        <div className="sidebar-foot">
          {user ? (
            <>
              <div className="user-card">
                <span className="avatar" aria-hidden="true">
                  {(user.fullName || user.email).trim().charAt(0).toUpperCase()}
                </span>
                <span className="user-meta">
                  <span className="user-name" title={user.fullName}>
                    {user.fullName || 'Без имени'}
                  </span>
                  <span className="user-role">{user.role === 'admin' ? 'Администратор' : 'Клиент'}</span>
                </span>
              </div>
              <Link to="/billing" className={`${balanceClass} balance-block`} title="Баланс">
                <span className="balance-caption">На счёте</span>
                <span className="balance-amount mono">{formatMoney(balanceValue)}</span>
              </Link>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                disabled={logout.isPending}
                onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login') })}
              >
                <IconLogout size={18} />
                Выйти
              </button>
            </>
          ) : (
            <div className="guest-actions">
              <Link to="/login" className="btn btn-block">
                <IconLogin size={18} />
                Войти
              </Link>
              <Link to="/register" className="btn btn-primary btn-block">
                Регистрация
              </Link>
            </div>
          )}
        </div>
      </aside>
      {open && <div className="scrim" aria-hidden="true" onClick={() => setOpen(false)} />}

      <div className="main-col">
        {user && !user.emailVerified && <VerifyBanner />}
        <main id="main" className="container">
          {/* ленивые разделы (админка) грузятся внутри каркаса: навигация не пропадает на время загрузки */}
          <Suspense fallback={<Skeleton />}>
            <Outlet />
          </Suspense>
        </main>
        <footer className="footer">GPU Rent, учебный проект. Оплата в демо-режиме: реальные деньги не списываются.</footer>
      </div>
    </div>
  );
}

function VerifyBanner() {
  return (
    <div className="banner" role="status">
      Email не подтверждён: запуск инстансов недоступен. <Link to="/settings">Подтвердить email</Link>
    </div>
  );
}

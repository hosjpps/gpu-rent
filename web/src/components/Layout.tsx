import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useBalance, useLogout, useMe } from '../api/hooks';
import { formatMoney, toNumber } from '../lib/format';

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? 'nav-link active' : 'nav-link';
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

  const balanceValue = balance.data?.balance ?? user?.balance;
  const negative = balanceValue !== undefined && toNumber(balanceValue) < 0;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label="GPU Rent, главная">
            <span className="brand-mark" aria-hidden="true">
              ▦
            </span>
            GPU Rent
          </Link>
          <button
            type="button"
            className="menu-btn"
            aria-expanded={open}
            aria-controls="main-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Закрыть' : 'Меню'}
          </button>
          <nav id="main-nav" className={open ? 'nav open' : 'nav'} aria-label="Основная навигация">
            <NavLink to="/" end className={navClass}>
              Каталог
            </NavLink>
            {user && (
              <>
                <NavLink to="/instances" className={navClass}>
                  Инстансы
                </NavLink>
                <NavLink to="/volumes" className={navClass}>
                  Тома
                </NavLink>
                <NavLink to="/billing" className={navClass}>
                  Баланс
                </NavLink>
                <NavLink to="/settings" className={navClass}>
                  Настройки
                </NavLink>
                {user.role === 'admin' && (
                  <NavLink to="/admin" className={navClass}>
                    Админка
                  </NavLink>
                )}
              </>
            )}
            <div className="nav-user">
              {user ? (
                <>
                  <Link to="/billing" className={negative ? 'balance balance-neg' : 'balance'} title="Баланс">
                    {formatMoney(balanceValue)}
                  </Link>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={logout.isPending}
                    onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login') })}
                  >
                    Выйти
                  </button>
                </>
              ) : (
                <>
                  <Link to="/login" className="btn btn-sm">
                    Войти
                  </Link>
                  <Link to="/register" className="btn btn-sm btn-primary">
                    Регистрация
                  </Link>
                </>
              )}
            </div>
          </nav>
        </div>
      </header>
      {user && !user.emailVerified && <VerifyBanner />}
      <main id="main" className="container">
        <Outlet />
      </main>
      <footer className="footer">GPU Rent · учебный проект · оплата в демо-режиме, реальные деньги не списываются</footer>
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

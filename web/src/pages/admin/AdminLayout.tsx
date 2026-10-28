import { NavLink, Outlet } from 'react-router-dom';
import { PageHead } from '../../components/ui';

const LINKS = [
  { to: '/admin', label: 'Дашборд', end: true },
  { to: '/admin/prices', label: 'Цены' },
  { to: '/admin/infrastructure', label: 'Инфраструктура' },
  { to: '/admin/users', label: 'Пользователи' },
  { to: '/admin/audit', label: 'Журнал аудита' },
];

export default function AdminLayout() {
  return (
    <>
      <PageHead title="Администрирование" />
      <nav className="tabs" aria-label="Разделы админки">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
            {l.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

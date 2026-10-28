import { lazy, Suspense } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { GuestOnly, RequireAdmin, RequireAuth } from './components/guards';
import { ToastProvider } from './components/Toast';
import { Spinner } from './components/ui';
import { CatalogPage } from './pages/CatalogPage';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { VerifyPage } from './pages/VerifyPage';
import { InstancesPage } from './pages/InstancesPage';
import { InstanceDetailPage } from './pages/InstanceDetailPage';
import { VolumesPage } from './pages/VolumesPage';
import { BillingPage } from './pages/BillingPage';
import { SettingsPage } from './pages/SettingsPage';

// Админка нужна одному пользователю из многих, поэтому грузим её отдельным чанком только по требованию
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'));
const AdminDashboard = lazy(() => import('./pages/admin/DashboardPage'));
const AdminPrices = lazy(() => import('./pages/admin/PricesPage'));
const AdminInfrastructure = lazy(() => import('./pages/admin/InfrastructurePage'));
const AdminUsers = lazy(() => import('./pages/admin/UsersPage'));
const AdminAudit = lazy(() => import('./pages/admin/AuditPage'));

function NotFound() {
  return (
    <div className="empty">
      <p className="empty-title">Страница не найдена</p>
      <p>
        <Link to="/">Перейти в каталог</Link>
      </p>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<Spinner />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<CatalogPage />} />
            <Route element={<GuestOnly />}>
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
            </Route>
            <Route path="verify" element={<VerifyPage />} />
            <Route element={<RequireAuth />}>
              <Route path="instances" element={<InstancesPage />} />
              <Route path="instances/:id" element={<InstanceDetailPage />} />
              <Route path="volumes" element={<VolumesPage />} />
              <Route path="billing" element={<BillingPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route element={<RequireAdmin />}>
                <Route path="admin" element={<AdminLayout />}>
                  <Route index element={<AdminDashboard />} />
                  <Route path="prices" element={<AdminPrices />} />
                  <Route path="infrastructure" element={<AdminInfrastructure />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="audit" element={<AdminAudit />} />
                </Route>
              </Route>
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </ToastProvider>
  );
}

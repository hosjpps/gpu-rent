import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './api/client';
import { keys } from './api/hooks';
import { App } from './App';
import { applyStoredTheme } from './components/ThemeToggle';
import './styles.css';

applyStoredTheme();

// 401 на любом запросе, кроме проверки «кто я», может значить истёкшую сессию. Не гадаем, а перепроверяем:
// если /auth/me тоже ответит 401, пользователь станет «гостем» и RequireAuth отправит его на вход.
// (Неверный текущий пароль при смене пароля тоже может дать 401, но сессия при этом жива.)
function handleUnauthorized(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && queryClient.getQueryData(keys.me)) {
    void queryClient.invalidateQueries({ queryKey: keys.me });
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleUnauthorized }),
  mutationCache: new MutationCache({ onError: handleUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // Повторяем только сетевые сбои и 5xx; ошибки 4xx повтор не исправит
      retry: (count, error) => count < 2 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

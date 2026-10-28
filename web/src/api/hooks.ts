// Запросы и мутации TanStack Query. Ключи кэша собраны в одном месте, чтобы после мутаций
// было видно, что именно инвалидируется.
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, ApiError } from './client';
import type {
  AdminPrice,
  AdminUser,
  ApiKey,
  AuditEntry,
  Balance,
  CreatedApiKey,
  Dashboard,
  GpuOffer,
  InfraDatacenter,
  Instance,
  LaunchRequest,
  NewPrice,
  Page,
  PaymentCreated,
  Spend,
  SshKey,
  Template,
  Transaction,
  User,
  VerifyInfo,
  Volume,
} from './types';

export const keys = {
  me: ['me'] as const,
  balance: ['balance'] as const,
  catalog: ['catalog', 'gpus'] as const,
  templates: ['catalog', 'templates'] as const,
  myTemplates: ['templates', 'mine'] as const,
  instances: ['instances'] as const,
  instance: (id: string) => ['instances', id] as const,
  volumes: ['volumes'] as const,
  sshKeys: ['ssh-keys'] as const,
  apiKeys: ['api-keys'] as const,
  transactions: ['transactions'] as const,
  spend: (from: string, to: string) => ['spend', from, to] as const,
  dashboard: ['admin', 'dashboard'] as const,
  prices: ['admin', 'prices'] as const,
  infra: ['admin', 'infrastructure'] as const,
  users: ['admin', 'users'] as const,
  audit: ['admin', 'audit'] as const,
};

// Каталог и цены меняются редко, поэтому свежими считаем 30 секунд (как s-maxage на CDN)
const CATALOG_STALE_MS = 30_000;

// ---------------------------------------------------------------- авторизация

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async (): Promise<User | null> => {
      try {
        return (await api.get<{ user: User }>('/auth/me')).user;
      } catch (e) {
        // Не вошёл — это штатное состояние, а не ошибка
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.post<{ user: User }>('/auth/login', v),
    onSuccess: ({ user }) => {
      qc.clear();
      qc.setQueryData(keys.me, user);
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { email: string; password: string; fullName: string }) => {
      const created = await api.post<VerifyInfo & { user: User }>('/auth/register', v);
      // Если сервер не открыл сессию при регистрации, входим теми же данными
      let user = created.user;
      try {
        user = (await api.get<{ user: User }>('/auth/me')).user;
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        user = (await api.post<{ user: User }>('/auth/login', { email: v.email, password: v.password })).user;
      }
      return { user, verifyUrl: created.verifyUrl ?? null };
    },
    onSuccess: ({ user }) => {
      qc.clear();
      qc.setQueryData(keys.me, user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(keys.me, null);
    },
  });
}

export function useChangePassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { currentPassword: string; newPassword: string }) => api.post<{ apiKeysRevoked: number }>('/auth/password', v),
    // Смена пароля отзывает API-ключи на сервере: список в кэше устарел.
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys }),
  });
}

export function useVerifyEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.post('/auth/verify', { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: () => api.post<VerifyInfo>('/auth/resend'),
  });
}

// ---------------------------------------------------------------- каталог

export function useCatalog() {
  return useQuery({
    queryKey: keys.catalog,
    queryFn: ({ signal }) => api.get<GpuOffer[]>('/catalog/gpus', undefined, signal),
    staleTime: CATALOG_STALE_MS,
    // Наличие GPU меняется, пока пользователь смотрит каталог
    refetchInterval: 60_000,
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: keys.templates,
    queryFn: ({ signal }) => api.get<Template[]>('/catalog/templates', undefined, signal),
    staleTime: CATALOG_STALE_MS,
  });
}

export function useMyTemplates(enabled: boolean) {
  return useQuery({
    queryKey: keys.myTemplates,
    queryFn: ({ signal }) => api.get<Template[]>('/templates/mine', undefined, signal),
    enabled,
  });
}

// ---------------------------------------------------------------- инстансы

const TRANSITIONAL = new Set(['pending']);

export function useInstances(all = false) {
  return useQuery({
    queryKey: [...keys.instances, { all }],
    queryFn: ({ signal }) => api.get<Instance[]>('/instances', all ? { all: 1 } : undefined, signal),
    // Статусы обновляем сами: быстрее, пока есть инстанс в переходном состоянии
    refetchInterval: (q) => (q.state.data?.some((i) => TRANSITIONAL.has(i.status)) ? 3_000 : 15_000),
  });
}

export function useInstance(id: string) {
  return useQuery({
    queryKey: keys.instance(id),
    queryFn: ({ signal }) => api.get<Instance>(`/instances/${id}`, undefined, signal),
    refetchInterval: (q) => (q.state.data && TRANSITIONAL.has(q.state.data.status) ? 3_000 : 15_000),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
}

/** После любого изменения инстанса меняются список, наличие GPU в каталоге, тома и баланс */
function useInvalidateAfterInstanceChange() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [keys.instances, keys.catalog, keys.volumes, keys.balance, keys.transactions, keys.me].map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
      ),
    );
}

export function useLaunchInstance() {
  const invalidate = useInvalidateAfterInstanceChange();
  return useMutation({
    mutationFn: (v: LaunchRequest) => api.post<Instance>('/instances', v),
    onSuccess: invalidate,
  });
}

export function useInstanceAction(action: 'stop' | 'resume' | 'terminate') {
  const invalidate = useInvalidateAfterInstanceChange();
  return useMutation({
    mutationFn: (id: string) => api.post<Instance | undefined>(`/instances/${id}/${action}`),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------- тома

export function useVolumes() {
  return useQuery({
    queryKey: keys.volumes,
    queryFn: ({ signal }) => api.get<Volume[]>('/volumes', undefined, signal),
  });
}

function useVolumeMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.volumes }),
  });
}

export const useCreateVolume = () =>
  useVolumeMutation((v: { name: string; datacenterCode: string; sizeGb: number }) => api.post('/volumes', v));
export const useExtendVolume = () =>
  useVolumeMutation((v: { id: number; sizeGb: number }) => api.post(`/volumes/${v.id}/extend`, { sizeGb: v.sizeGb }));
export const useDeleteVolume = () => useVolumeMutation((id: number) => api.del(`/volumes/${id}`));

// ---------------------------------------------------------------- ключи

export function useSshKeys() {
  return useQuery({
    queryKey: keys.sshKeys,
    queryFn: ({ signal }) => api.get<SshKey[]>('/ssh-keys', undefined, signal),
  });
}

export function useAddSshKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; publicKey: string }) => api.post<SshKey>('/ssh-keys', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.sshKeys }),
  });
}

export function useDeleteSshKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/ssh-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.sshKeys }),
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: keys.apiKeys,
    queryFn: ({ signal }) => api.get<ApiKey[]>('/api-keys', undefined, signal),
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; expiresAt?: string }) => api.post<CreatedApiKey>('/api-keys', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys }),
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.apiKeys }),
  });
}

// ---------------------------------------------------------------- баланс и платежи

export function useBalance(enabled = true) {
  return useQuery({
    queryKey: keys.balance,
    queryFn: ({ signal }) => api.get<Balance>('/billing/balance', undefined, signal),
    enabled,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useTransactions() {
  return useInfiniteQuery({
    queryKey: keys.transactions,
    queryFn: ({ pageParam, signal }) =>
      api.get<Page<Transaction>>('/billing/transactions', { cursor: pageParam, limit: 20 }, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useSpend(from: string, to: string) {
  return useQuery({
    queryKey: keys.spend(from, to),
    queryFn: ({ signal }) => api.get<Spend>('/billing/spend', { from, to }, signal),
  });
}

export function useCreatePayment() {
  return useMutation({
    mutationFn: (amount: number) => api.post<PaymentCreated>('/payments', { amount }),
  });
}

export function useDemoPay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: number) => api.post(`/payments/${paymentId}/demo-pay`),
    onSuccess: () =>
      Promise.all([keys.balance, keys.transactions, keys.me].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

// ---------------------------------------------------------------- админ

export function useDashboard() {
  return useQuery({
    queryKey: keys.dashboard,
    queryFn: ({ signal }) => api.get<Dashboard>('/admin/dashboard', undefined, signal),
    refetchInterval: 60_000,
  });
}

export function usePrices() {
  return useQuery({
    queryKey: keys.prices,
    queryFn: ({ signal }) => api.get<AdminPrice[]>('/admin/prices', undefined, signal),
  });
}

export function useSetPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NewPrice) => api.post('/admin/prices', v),
    onSuccess: () =>
      Promise.all([keys.prices, keys.catalog, keys.audit].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export function useInfrastructure() {
  return useQuery({
    queryKey: keys.infra,
    queryFn: ({ signal }) => api.get<InfraDatacenter[]>('/admin/infrastructure', undefined, signal),
  });
}

function useInfraMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all([keys.infra, keys.catalog, keys.dashboard].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useToggleGpu = () =>
  useInfraMutation((v: { id: number; enable: boolean }) => api.post(`/admin/gpus/${v.id}/${v.enable ? 'enable' : 'disable'}`));
export const useSetNodeStatus = () =>
  useInfraMutation((v: { id: number; status: string }) => api.post(`/admin/nodes/${v.id}/status`, { status: v.status }));

// Поиск выполняет сервер: он отдаёт не больше 200 пользователей за запрос, фильтровать на клиенте было бы неполно
export function useAdminUsers(q = '') {
  return useQuery({
    queryKey: [...keys.users, q],
    queryFn: ({ signal }) => api.get<AdminUser[]>('/admin/users', { q, limit: 200 }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useBlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; block: boolean }) => api.post(`/admin/users/${v.id}/${v.block ? 'block' : 'unblock'}`),
    onSuccess: () => Promise.all([keys.users, keys.audit].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export function useAudit() {
  return useInfiniteQuery({
    queryKey: keys.audit,
    queryFn: ({ pageParam, signal }) => api.get<Page<AuditEntry>>('/admin/audit', { cursor: pageParam }, signal),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

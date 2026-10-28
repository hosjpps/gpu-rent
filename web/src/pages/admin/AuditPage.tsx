import { useAudit } from '../../api/hooks';
import { Empty, QueryState } from '../../components/ui';
import { formatDateTime } from '../../lib/format';

export default function AuditPage() {
  const audit = useAudit();
  const rows = audit.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <QueryState isLoading={audit.isLoading} error={audit.error} onRetry={() => void audit.refetch()} />
      {audit.data && rows.length === 0 && <Empty title="Записей пока нет" />}
      {rows.length > 0 && (
        <div className="card flush">
          <table className="table responsive" data-testid="audit-table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Кто</th>
                <th>Действие</th>
                <th>Объект</th>
                <th>Подробности</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Время" className="nowrap">
                    {formatDateTime(r.createdAt)}
                  </td>
                  <td data-label="Кто">{r.actor?.email ?? 'система'}</td>
                  <td data-label="Действие" className="mono small">
                    {r.action}
                  </td>
                  <td data-label="Объект" className="small">
                    {r.entity}
                    {r.entityId ? ` #${r.entityId.slice(0, 8)}` : ''}
                  </td>
                  <td data-label="Подробности" className="mono small audit-details">
                    <span className="clamp" title={JSON.stringify(r.details, null, 2)}>
                      {JSON.stringify(r.details)}
                    </span>
                  </td>
                  <td data-label="IP" className="mono small">
                    {r.ip ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {audit.hasNextPage && (
        <div className="row center">
          <button type="button" className="btn" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
            {audit.isFetchingNextPage ? 'Загрузка…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </>
  );
}

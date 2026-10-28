import type { Instance } from '../api/types';
import { formatDuration } from '../lib/format';
import { useNow } from './ui';

/** Время работы текущего сеанса: идёт у работающего, зафиксировано у остановленного */
export function Runtime({ instance }: { instance: Instance }) {
  const running = instance.status === 'running';
  const now = useNow(running);
  if (!instance.startedAt) return <>—</>;
  const start = new Date(instance.startedAt).getTime();
  const endIso = instance.stoppedAt ?? instance.terminatedAt;
  const end = running ? now : endIso ? new Date(endIso).getTime() : null;
  if (end === null) return <>—</>;
  return <>{formatDuration(end - start)}</>;
}

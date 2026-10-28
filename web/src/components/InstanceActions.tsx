import { useState } from 'react';
import { useInstanceAction } from '../api/hooks';
import type { Instance } from '../api/types';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';

type Action = 'stop' | 'resume' | 'terminate';

const TEXT: Record<Action, { title: string; button: string; done: string; body: string }> = {
  stop: {
    title: 'Остановить инстанс?',
    button: 'Остановить',
    done: 'Инстанс остановлен',
    body: 'Работа прекратится, GPU освободятся, оплата за GPU остановится. Сетевой том, если он подключён, останется на месте, его хранение оплачивается отдельно. При повторном запуске нужна свободная GPU в том же дата-центре.',
  },
  resume: {
    title: 'Запустить инстанс снова?',
    button: 'Запустить',
    done: 'Инстанс запускается',
    body: 'Выделим свободные GPU и снова начнём посекундное списание по текущей цене тарифа. Для запуска нужен баланс не меньше стоимости часа.',
  },
  terminate: {
    title: 'Удалить инстанс?',
    button: 'Удалить',
    done: 'Инстанс удалён',
    body: 'Инстанс будет удалён без возможности восстановления, данные на диске контейнера пропадут. Подключённый сетевой том останется.',
  },
};

export function InstanceActions({ instance, onDone }: { instance: Instance; onDone?: (a: Action) => void }) {
  const [confirm, setConfirm] = useState<Action | null>(null);
  const stop = useInstanceAction('stop');
  const resume = useInstanceAction('resume');
  const terminate = useInstanceAction('terminate');
  const toast = useToast();
  const mutations = { stop, resume, terminate };
  const busy = stop.isPending || resume.isPending || terminate.isPending;
  const s = instance.status;

  function run(action: Action) {
    mutations[action].mutate(instance.id, {
      onSuccess: () => {
        setConfirm(null);
        toast(`${TEXT[action].done}: ${instance.name}`);
        onDone?.(action);
      },
    });
  }

  function open(action: Action) {
    mutations[action].reset();
    setConfirm(action);
  }

  return (
    <>
      <div className="row">
        {s === 'running' && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => open('stop')}>
            Стоп
          </button>
        )}
        {s === 'stopped' && (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => open('resume')}>
            Старт
          </button>
        )}
        {s !== 'terminated' && (
          <button type="button" className="btn btn-sm btn-danger-outline" disabled={busy} onClick={() => open('terminate')}>
            Удалить
          </button>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={`${TEXT[confirm].title} «${instance.name}»`}
          confirmText={TEXT[confirm].button}
          danger={confirm === 'terminate'}
          pending={mutations[confirm].isPending}
          error={mutations[confirm].error}
          onConfirm={() => run(confirm)}
          onCancel={() => setConfirm(null)}
        >
          {TEXT[confirm].body}
        </ConfirmDialog>
      )}
    </>
  );
}

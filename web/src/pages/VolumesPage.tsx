import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useCatalog, useCreateVolume, useDeleteVolume, useExtendVolume, useVolumes } from '../api/hooks';
import type { Volume } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Dialog } from '../components/Dialog';
import { ErrorNote } from '../components/ErrorNote';
import { IconDisk, IconPlus } from '../components/icons';
import { useToast } from '../components/Toast';
import { Empty, Field, PageHead, QueryState } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { validateName } from '../lib/validation';

const MIN_GB = 10;
const MAX_GB = 10000;

function validateSize(raw: string, min = MIN_GB): string | null {
  const n = Number(raw);
  if (!Number.isInteger(n)) return 'Размер: целое число гигабайт';
  if (n < min) return `Не меньше ${min} ГБ`;
  if (n > MAX_GB) return `Не больше ${MAX_GB} ГБ`;
  return null;
}

export function VolumesPage() {
  const volumes = useVolumes();
  const [creating, setCreating] = useState(false);
  const [extending, setExtending] = useState<Volume | null>(null);
  const [deleting, setDeleting] = useState<Volume | null>(null);
  const list = (volumes.data ?? []).filter((v) => v.status === 'active');

  return (
    <>
      <PageHead title="Сетевые тома">
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <IconPlus size={18} />
          Создать том
        </button>
      </PageHead>
      <p className="muted page-lead">
        Том живёт отдельно от инстансов и хранит данные между запусками. Он привязан к одному дата-центру и
        подключается не более чем к одному инстансу. Размер можно только увеличивать.
      </p>

      <QueryState isLoading={volumes.isLoading} error={volumes.error} onRetry={() => void volumes.refetch()} />
      {volumes.data && list.length === 0 && (
        <div className="card">
          <Empty title="Томов пока нет" icon={<IconDisk size={28} />}>
            Создайте первый том кнопкой выше: данные на нём переживут остановку и удаление инстанса.
          </Empty>
        </div>
      )}

      {list.length > 0 && (
        <div className="card flush">
          <table className="table responsive" data-testid="volumes-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Дата-центр</th>
                <th className="num">Размер</th>
                <th>Подключён к</th>
                <th>Создан</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr key={v.id}>
                  <td data-label="Название">
                    <strong>{v.name}</strong>
                  </td>
                  <td data-label="Дата-центр">
                    <span className="code-chip mono">{v.datacenter.code}</span>
                  </td>
                  <td data-label="Размер" className="num mono">
                    {v.sizeGb} ГБ
                  </td>
                  <td data-label="Подключён к">
                    {v.attachedTo ? <Link to={`/instances/${v.attachedTo.id}`}>{v.attachedTo.name}</Link> : '—'}
                  </td>
                  <td data-label="Создан">{formatDateTime(v.createdAt)}</td>
                  <td className="actions">
                    <div className="row">
                      <button type="button" className="btn btn-sm" onClick={() => setExtending(v)}>
                        Расширить
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-outline"
                        disabled={!!v.attachedTo}
                        title={v.attachedTo ? 'Том подключён к инстансу: остановка не освобождает его, сначала удалите инстанс' : undefined}
                        onClick={() => setDeleting(v)}
                      >
                        Удалить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateVolumeDialog onClose={() => setCreating(false)} />}
      {extending && <ExtendVolumeDialog volume={extending} onClose={() => setExtending(null)} />}
      {deleting && <DeleteVolumeDialog volume={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

function CreateVolumeDialog({ onClose }: { onClose: () => void }) {
  const catalog = useCatalog();
  const create = useCreateVolume();
  const toast = useToast();
  const dcs = [...new Map((catalog.data ?? []).map((o) => [o.datacenter.code, o.datacenter] as const)).values()];
  const [name, setName] = useState('');
  const [dc, setDc] = useState('');
  const [size, setSize] = useState('100');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const dcValue = dc || dcs[0]?.code || '';

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = { name: validateName(name), size: validateSize(size), dc: dcValue ? null : 'Выберите дата-центр' };
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    create.mutate(
      { name: name.trim(), datacenterCode: dcValue, sizeGb: Number(size) },
      {
        onSuccess: () => {
          toast(`Том «${name.trim()}» создан`);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog title="Новый том" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Название" error={errors.name}>
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Field label="Дата-центр" error={errors.dc} hint="Том можно подключить только к инстансам этого дата-центра">
          <select name="datacenter" value={dcValue} onChange={(e) => setDc(e.target.value)}>
            {dcs.map((d) => (
              <option key={d.code} value={d.code}>
                {d.city} · {d.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Размер, ГБ (${MIN_GB}–${MAX_GB})`} error={errors.size}>
          <input type="number" name="sizeGb" min={MIN_GB} max={MAX_GB} value={size} onChange={(e) => setSize(e.target.value)} />
        </Field>
        <ErrorNote error={create.error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose} disabled={create.isPending}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём…' : 'Создать'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ExtendVolumeDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const extend = useExtendVolume();
  const toast = useToast();
  const [size, setSize] = useState(String(volume.sizeGb + 50));
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateSize(size, volume.sizeGb + 1);
    setError(err);
    if (err) return;
    extend.mutate(
      { id: volume.id, sizeGb: Number(size) },
      {
        onSuccess: () => {
          toast(`Том «${volume.name}» расширен до ${size} ГБ`);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog title={`Расширить «${volume.name}»`} onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        <p className="muted">Сейчас {volume.sizeGb} ГБ. Уменьшить том нельзя.</p>
        <Field label="Новый размер, ГБ" error={error}>
          <input type="number" name="sizeGb" value={size} onChange={(e) => setSize(e.target.value)} />
        </Field>
        <ErrorNote error={extend.error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose} disabled={extend.isPending}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={extend.isPending}>
            {extend.isPending ? 'Расширяем…' : 'Расширить'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteVolumeDialog({ volume, onClose }: { volume: Volume; onClose: () => void }) {
  const del = useDeleteVolume();
  const toast = useToast();
  return (
    <ConfirmDialog
      title={`Удалить том «${volume.name}»?`}
      confirmText="Удалить"
      danger
      pending={del.isPending}
      error={del.error}
      onCancel={onClose}
      onConfirm={() =>
        del.mutate(volume.id, {
          onSuccess: () => {
            toast(`Том «${volume.name}» удалён`);
            onClose();
          },
        })
      }
    >
      Все данные на томе ({volume.sizeGb} ГБ) будут удалены без возможности восстановления.
    </ConfirmDialog>
  );
}

import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import {
  useAddSshKey,
  useApiKeys,
  useChangePassword,
  useCreateApiKey,
  useDeleteApiKey,
  useDeleteSshKey,
  useMe,
  useResendVerification,
  useSshKeys,
  useVerifyEmail,
} from '../api/hooks';
import type { ApiKey, SshKey } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorNote } from '../components/ErrorNote';
import { useToast } from '../components/Toast';
import { CopyButton, Empty, Field, PageHead, QueryState } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { validateName, validatePassword, validateSshKey } from '../lib/validation';

export function SettingsPage() {
  return (
    <>
      <PageHead title="Настройки" />
      <EmailCard />
      <SshKeysCard />
      <ApiKeysCard />
      <PasswordCard />
    </>
  );
}

/** Из ссылки подтверждения достаём токен: либо ?token=…, либо последний сегмент пути */
function tokenFromUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    return u.searchParams.get('token') ?? u.pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
}

function EmailCard() {
  const me = useMe().data;
  const location = useLocation();
  const toast = useToast();
  const resend = useResendVerification();
  const verify = useVerifyEmail();
  const [url, setUrl] = useState<string | null>((location.state as { verifyUrl?: string | null } | null)?.verifyUrl ?? null);
  if (!me) return null;

  return (
    <section className="card section">
      <h2>Профиль</h2>
      <dl className="kv">
        <dt>Имя</dt>
        <dd>{me.fullName}</dd>
        <dt>Email</dt>
        <dd>
          {me.email}{' '}
          {me.emailVerified ? <span className="badge badge-running">подтверждён</span> : <span className="badge badge-stopped">не подтверждён</span>}
        </dd>
      </dl>
      {!me.emailVerified && (
        <div className="stack">
          <p className="muted small">
            Пока email не подтверждён, запускать инстансы нельзя. В учебной версии письма не отправляются: ссылка
            подтверждения показывается прямо здесь.
          </p>
          {url && (
            <div className="alert alert-ok">
              <p className="break small">{url}</p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={verify.isPending}
                onClick={() =>
                  verify.mutate(tokenFromUrl(url), {
                    onSuccess: () => {
                      toast('Email подтверждён');
                      setUrl(null);
                    },
                  })
                }
              >
                {verify.isPending ? 'Подтверждаем…' : 'Подтвердить (демо)'}
              </button>
            </div>
          )}
          <ErrorNote error={verify.error ?? resend.error} />
          {!url && (
            <div>
              <button
                type="button"
                className="btn btn-sm"
                disabled={resend.isPending}
                onClick={() => resend.mutate(undefined, { onSuccess: (r) => setUrl(r.verifyUrl ?? null) })}
              >
                {resend.isPending ? 'Отправляем…' : 'Получить ссылку подтверждения'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SshKeysCard() {
  const keys = useSshKeys();
  const add = useAddSshKey();
  const del = useDeleteSshKey();
  const toast = useToast();
  const [name, setName] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [deleting, setDeleting] = useState<SshKey | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = { name: validateName(name), publicKey: validateSshKey(publicKey) };
    setErrors(next);
    if (next.name || next.publicKey) return;
    add.mutate(
      { name: name.trim(), publicKey: publicKey.trim() },
      {
        onSuccess: () => {
          toast('SSH-ключ добавлен');
          setName('');
          setPublicKey('');
        },
      },
    );
  }

  return (
    <section className="card section">
      <h2>SSH-ключи</h2>
      <QueryState isLoading={keys.isLoading} error={keys.error} onRetry={() => void keys.refetch()} />
      {keys.data && keys.data.length === 0 && <Empty title="Ключей нет">Добавьте ключ, чтобы подключаться к инстансам по SSH.</Empty>}
      {keys.data && keys.data.length > 0 && (
        <div className="table-scroll">
          <table className="table responsive" data-testid="ssh-keys">
            <thead>
              <tr>
                <th>Название</th>
                <th>Отпечаток</th>
                <th>Добавлен</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td data-label="Название">{k.name}</td>
                  <td data-label="Отпечаток" className="mono small break">
                    {k.fingerprint}
                  </td>
                  <td data-label="Добавлен">{formatDateTime(k.createdAt)}</td>
                  <td className="actions">
                    <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setDeleting(k)}>
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form className="stack form-block" onSubmit={submit} noValidate>
        <h3>Добавить ключ</h3>
        <Field label="Название" error={errors.name}>
          <input name="sshName" value={name} onChange={(e) => setName(e.target.value)} placeholder="ноутбук" maxLength={64} />
        </Field>
        <Field label="Публичный ключ" error={errors.publicKey}>
          <textarea
            name="publicKey"
            rows={3}
            className="mono"
            placeholder="ssh-ed25519 AAAA… user@host"
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
          />
        </Field>
        <ErrorNote error={add.error} />
        <div>
          <button type="submit" className="btn btn-primary" disabled={add.isPending}>
            {add.isPending ? 'Добавляем…' : 'Добавить ключ'}
          </button>
        </div>
      </form>
      {deleting && (
        <ConfirmDialog
          title={`Удалить ключ «${deleting.name}»?`}
          confirmText="Удалить"
          danger
          pending={del.isPending}
          error={del.error}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            del.mutate(deleting.id, {
              onSuccess: () => {
                toast('SSH-ключ удалён');
                setDeleting(null);
              },
            })
          }
        >
          Запущенные инстансы продолжат работать, но новые с этим ключом создать будет нельзя.
        </ConfirmDialog>
      )}
    </section>
  );
}

function ApiKeysCard() {
  const keys = useApiKeys();
  const create = useCreateApiKey();
  const del = useDeleteApiKey();
  const toast = useToast();
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateName(name);
    setError(err);
    if (err) return;
    const body: { name: string; expiresAt?: string } = { name: name.trim() };
    // Срок действует до конца выбранного дня по местному времени
    if (expires) body.expiresAt = new Date(`${expires}T23:59:59`).toISOString();
    create.mutate(body, {
      onSuccess: (res) => {
        setFresh(res.key);
        setName('');
        setExpires('');
      },
    });
  }

  return (
    <section className="card section">
      <h2>API-ключи</h2>
      <p className="muted small">
        Ключ нужен для доступа к API без входа через сайт: заголовок <code>Authorization: Bearer gr_…</code>.
      </p>

      {fresh && (
        <div className="alert alert-ok" role="status" data-testid="new-api-key">
          <p>
            <strong>Скопируйте ключ сейчас: больше мы его не покажем.</strong>
          </p>
          <p className="mono break key-value">{fresh}</p>
          <div className="row">
            <CopyButton text={fresh} />
            <button type="button" className="btn btn-sm" onClick={() => setFresh(null)}>
              Я сохранил ключ
            </button>
          </div>
        </div>
      )}

      <QueryState isLoading={keys.isLoading} error={keys.error} onRetry={() => void keys.refetch()} />
      {keys.data && keys.data.length === 0 && <Empty title="API-ключей нет" />}
      {keys.data && keys.data.length > 0 && (
        <div className="table-scroll">
          <table className="table responsive" data-testid="api-keys">
            <thead>
              <tr>
                <th>Название</th>
                <th>Начало ключа</th>
                <th>Последнее использование</th>
                <th>Действует до</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td data-label="Название">
                    {k.name} {k.revokedAt && <span className="badge badge-failed">отозван</span>}
                  </td>
                  <td data-label="Начало ключа" className="mono">
                    {k.prefix}…
                  </td>
                  <td data-label="Использован">{formatDateTime(k.lastUsedAt)}</td>
                  <td data-label="До">{k.expiresAt ? formatDateTime(k.expiresAt) : 'без срока'}</td>
                  <td className="actions">
                    {!k.revokedAt && (
                      <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setRevoking(k)}>
                        Отозвать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="stack form-block" onSubmit={submit} noValidate>
        <h3>Новый ключ</h3>
        <div className="grid-2">
          <Field label="Название" error={error}>
            <input name="apiKeyName" value={name} onChange={(e) => setName(e.target.value)} placeholder="CI" maxLength={64} />
          </Field>
          <Field label="Действует до (необязательно)">
            <input type="date" name="expires" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={create.error} />
        <div>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём…' : 'Создать ключ'}
          </button>
        </div>
      </form>

      {revoking && (
        <ConfirmDialog
          title={`Отозвать ключ «${revoking.name}»?`}
          confirmText="Отозвать"
          danger
          pending={del.isPending}
          error={del.error}
          onCancel={() => setRevoking(null)}
          onConfirm={() =>
            del.mutate(revoking.id, {
              onSuccess: () => {
                toast('API-ключ отозван');
                setRevoking(null);
              },
            })
          }
        >
          Запросы с этим ключом сразу перестанут проходить.
        </ConfirmDialog>
      )}
    </section>
  );
}

function PasswordCard() {
  const change = useChangePassword();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    const found = {
      current: current ? null : 'Введите текущий пароль',
      next: validatePassword(next),
    };
    setErrors(found);
    if (found.current || found.next) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: ({ apiKeysRevoked }) => {
          toast(
            apiKeysRevoked > 0
              ? `Пароль изменён, остальные сессии завершены, API-ключи (${apiKeysRevoked}) отозваны: выпустите новые`
              : 'Пароль изменён, остальные сессии завершены',
          );
          setCurrent('');
          setNext('');
        },
      },
    );
  }

  return (
    <section className="card section">
      <h2>Смена пароля</h2>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="grid-2">
          <Field label="Текущий пароль" error={errors.current}>
            <input type="password" name="currentPassword" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="Новый пароль" error={errors.next} hint="Не короче 8 символов">
            <input type="password" name="newPassword" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={change.error} />
        <div>
          <button type="submit" className="btn btn-primary" disabled={change.isPending}>
            {change.isPending ? 'Сохраняем…' : 'Сменить пароль'}
          </button>
        </div>
        <p className="muted small">После смены пароля вы останетесь в системе здесь, а на других устройствах нужно будет войти заново.</p>
      </form>
    </section>
  );
}

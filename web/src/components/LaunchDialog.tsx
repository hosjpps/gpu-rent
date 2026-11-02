import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useBalance, useLaunchInstance, useMe, useMyTemplates, useSshKeys, useTemplates, useVolumes } from '../api/hooks';
import type { GpuOffer, LaunchRequest, PricingType } from '../api/types';
import { HOURS_IN_DAY, HOURS_IN_MONTH, hourlyCost, pricePerGpu } from '../lib/cost';
import { formatMoney, toNumber } from '../lib/format';
import { validateEnvName, validateName } from '../lib/validation';
import { Dialog } from './Dialog';
import { IconClose, IconPlay, IconPlus } from './icons';
import { ErrorNote } from './ErrorNote';
import { useToast } from './Toast';
import { Field } from './ui';

export interface LaunchPreset {
  datacenterCode: string;
  gpuModel: string;
  pricingType: PricingType;
}

interface EnvRow {
  name: string;
  value: string;
}

const MAX_GPUS = 8;

export function LaunchDialog({
  offers,
  preset,
  onClose,
}: {
  offers: GpuOffer[];
  preset: LaunchPreset;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe().data;
  const balance = useBalance().data?.balance ?? me?.balance ?? '0';
  const templates = useTemplates();
  const myTemplates = useMyTemplates(true);
  const volumes = useVolumes();
  const sshKeys = useSshKeys();
  const launch = useLaunchInstance();

  const allTemplates = useMemo(
    () => [...(templates.data ?? []), ...(myTemplates.data ?? [])],
    [templates.data, myTemplates.data],
  );

  const [name, setName] = useState(() => `pod-${Math.floor(1000 + Math.random() * 9000)}`);
  const [dc, setDc] = useState(preset.datacenterCode);
  const [model, setModel] = useState(preset.gpuModel);
  const [count, setCount] = useState(1);
  const [pricing, setPricing] = useState<PricingType>(preset.pricingType);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [disk, setDisk] = useState('');
  const [volumeId, setVolumeId] = useState('');
  const [sshKeyId, setSshKeyId] = useState('');
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const dcs = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of offers) map.set(o.datacenter.code, `${o.datacenter.city} · ${o.datacenter.code}`);
    return [...map.entries()];
  }, [offers]);
  const modelsInDc = offers.filter((o) => o.datacenter.code === dc);
  const offer = modelsInDc.find((o) => o.model.name === model);

  // Шаблон по умолчанию — первый в списке; диск подставляем из шаблона, пока пользователь его не менял
  const template = allTemplates.find((t) => t.id === templateId) ?? allTemplates[0];
  const diskValue = disk !== '' ? disk : template ? String(template.defaultDiskGb) : '';

  const maxCount = Math.max(1, Math.min(MAX_GPUS, offer?.free ?? 1));
  const freeVolumes = (volumes.data ?? []).filter(
    (v) => v.status === 'active' && v.datacenter.code === dc && !v.attachedTo,
  );

  const perGpu = offer ? pricePerGpu(offer, pricing) : null;
  const hour = hourlyCost(perGpu, count);
  const missing = hour !== null ? hour - toNumber(balance) : 0;

  function changeDc(code: string) {
    setDc(code);
    const first = offers.find((o) => o.datacenter.code === code && o.free > 0) ?? offers.find((o) => o.datacenter.code === code);
    if (first) setModel(first.model.name);
    setVolumeId('');
    setCount(1);
  }

  function changeModel(value: string) {
    setModel(value);
    setCount(1);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const nameError = validateName(name);
    if (nameError) next.name = nameError;
    if (!offer) next.model = 'Выберите модель GPU';
    else if (offer.free < 1) next.model = 'Свободных GPU этой модели нет';
    if (!Number.isInteger(count) || count < 1 || count > maxCount) next.count = `Доступно от 1 до ${maxCount} GPU`;
    if (perGpu === null) next.pricing = 'Для этого тарифа цена не задана';
    if (!template) next.template = 'Выберите шаблон';
    const diskNum = Number(diskValue);
    if (!Number.isInteger(diskNum) || diskNum < 10 || diskNum > 2000) next.disk = 'Диск: целое число от 10 до 2000 ГБ';
    const names = new Set<string>();
    env.forEach((row, i) => {
      const err = validateEnvName(row.name);
      if (err) next[`env${i}`] = err;
      else if (names.has(row.name)) next[`env${i}`] = 'Такая переменная уже есть';
      names.add(row.name);
    });
    setErrors(next);
    if (Object.keys(next).length > 0 || !offer || !template) return;

    const body: LaunchRequest = {
      name: name.trim(),
      datacenterCode: dc,
      gpuModel: model,
      gpuCount: count,
      pricingType: pricing,
      templateId: template.id,
      containerDiskGb: diskNum,
    };
    if (volumeId) body.volumeId = Number(volumeId);
    if (sshKeyId) body.sshKeyId = Number(sshKeyId);
    if (env.length > 0) body.env = Object.fromEntries(env.map((r) => [r.name, r.value]));

    launch.mutate(body, {
      onSuccess: () => {
        toast(`Инстанс «${body.name}» запускается`);
        onClose();
        navigate('/instances');
      },
    });
  }

  return (
    <Dialog title="Запустить инстанс" onClose={onClose} wide>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Название" error={errors.name}>
          <input name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>

        <div className="grid-2">
          <Field label="Дата-центр">
            <select name="datacenter" value={dc} onChange={(e) => changeDc(e.target.value)}>
              {dcs.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Модель GPU" error={errors.model}>
            <select name="model" value={model} onChange={(e) => changeModel(e.target.value)}>
              {modelsInDc.map((o) => (
                <option key={o.model.name} value={o.model.name} disabled={o.free === 0}>
                  {o.model.name} · {o.model.vramGb} ГБ · свободно {o.free}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid-2">
          <Field
            label={`Число GPU (1–${maxCount})`}
            error={errors.count}
            hint="Все GPU инстанса выделяются на одной ноде дата-центра"
          >
            <input
              type="number"
              name="gpuCount"
              min={1}
              max={maxCount}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            />
          </Field>
          <fieldset className="field">
            <legend className="field-label">Тариф</legend>
            <div className="radio-row">
              {(['on_demand', 'spot'] as const).map((type) => {
                const price = offer ? pricePerGpu(offer, type) : null;
                return (
                  <label key={type} className={`radio-card radio-${type}${pricing === type ? ' selected' : ''}`}>
                    <input
                      type="radio"
                      name="pricingType"
                      value={type}
                      checked={pricing === type}
                      onChange={() => setPricing(type)}
                      disabled={price === null}
                    />
                    <span>
                      <strong>{type === 'spot' ? 'Spot' : 'Обычный'}</strong>
                      <small>{price === null ? 'нет цены' : `${formatMoney(price)}/ч за GPU`}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            {errors.pricing && <span className="field-error">{errors.pricing}</span>}
          </fieldset>
        </div>

        <div className="grid-2">
          <Field label="Шаблон" error={errors.template}>
            <select
              name="template"
              value={template?.id ?? ''}
              onChange={(e) => {
                setTemplateId(Number(e.target.value));
                setDisk('');
              }}
            >
              {allTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isPublic ? '' : ' (мой)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Диск контейнера, ГБ" error={errors.disk}>
            <input
              type="number"
              name="containerDiskGb"
              min={10}
              max={2000}
              value={diskValue}
              onChange={(e) => setDisk(e.target.value)}
            />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Сетевой том" hint={freeVolumes.length === 0 ? 'В этом ДЦ нет свободных томов' : undefined}>
            <select name="volume" value={volumeId} onChange={(e) => setVolumeId(e.target.value)}>
              <option value="">Без тома</option>
              {freeVolumes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.sizeGb} ГБ
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="SSH-ключ"
            hint={(sshKeys.data ?? []).length === 0 ? 'Ключей пока нет: добавьте в «Настройках»' : undefined}
          >
            <select name="sshKey" value={sshKeyId} onChange={(e) => setSshKeyId(e.target.value)}>
              <option value="">Без ключа</option>
              {(sshKeys.data ?? []).map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="field">
          <legend className="field-label">Переменные окружения</legend>
          {env.map((row, i) => (
            <div key={i} className="env-row">
              <input
                aria-label={`Имя переменной ${i + 1}`}
                placeholder="NAME"
                value={row.name}
                onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
              />
              <input
                aria-label={`Значение переменной ${i + 1}`}
                placeholder="значение"
                autoComplete="off"
                value={row.value}
                onChange={(e) => setEnv(env.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Удалить переменную ${i + 1}`}
                onClick={() => setEnv(env.filter((_, j) => j !== i))}
              >
                <IconClose size={18} />
              </button>
              {errors[`env${i}`] && <span className="field-error env-error">{errors[`env${i}`]}</span>}
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setEnv([...env, { name: '', value: '' }])}>
              <IconPlus size={16} />
              Добавить переменную
            </button>
          </div>
          <span className="field-hint">Значения хранятся на сервере в зашифрованном виде.</span>
        </fieldset>

        <div className="cost-box" aria-live="polite">
          <div className="cost-main">
            <span>Стоимость часа</span>
            <strong className="mono" data-testid="hourly-cost">{hour === null ? '—' : formatMoney(hour)}</strong>
          </div>
          {hour !== null && (
            <div className="muted small">
              {formatMoney(perGpu)} × {count} GPU · сутки ≈ {formatMoney(hour * HOURS_IN_DAY)} · месяц ≈{' '}
              {formatMoney(hour * HOURS_IN_MONTH)}. Списание посекундное, итоговая цена фиксируется при запуске.
            </div>
          )}
          <div className="muted small">
            Баланс: {formatMoney(balance)}. Для запуска нужен баланс не меньше стоимости одного часа.
          </div>
          {hour !== null && missing > 0 && (
            <div className="alert alert-warn" role="status">
              Не хватает {formatMoney(missing)}. <Link to="/billing">Пополнить баланс</Link>
            </div>
          )}
          {me && !me.emailVerified && (
            <div className="alert alert-warn" role="status">
              Email не подтверждён, запуск будет отклонён. <Link to="/settings">Подтвердить</Link>
            </div>
          )}
        </div>

        <ErrorNote error={launch.error} />
        {launch.error instanceof ApiError && launch.error.code === 'NO_CAPACITY' && (
          <p className="field-hint">
            Свободные GPU могут быть разбросаны по разным нодам: ни на одной из них нет столько сразу. Уменьшите число GPU.
          </p>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose} disabled={launch.isPending}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={launch.isPending}>
            {!launch.isPending && <IconPlay size={16} />}
            {launch.isPending ? 'Запускаем…' : 'Запустить'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

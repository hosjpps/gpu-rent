import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useBalance, useCreatePayment, useDemoPay, useMe, useSpend, useTransactions } from '../api/hooks';
import type { PaymentCreated } from '../api/types';
import { BarChart } from '../components/BarChart';
import { ErrorNote } from '../components/ErrorNote';
import { IconWallet } from '../components/icons';
import { useToast } from '../components/Toast';
import { Empty, Field, PageHead, QueryState } from '../components/ui';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatMoneyPrecise,
  pad,
  toDateInput,
  toNumber,
  TX_LABEL,
} from '../lib/format';
import { validateAmount } from '../lib/validation';

const QUICK_AMOUNTS = [500, 1000, 5000, 10000];

export function BillingPage() {
  return (
    <>
      <PageHead title="Баланс и платежи" />
      <div className="grid-2">
        <BalanceCard />
        <TopUpCard />
      </div>
      <SpendSection />
      <TransactionsSection />
    </>
  );
}

function BalanceCard() {
  const me = useMe().data;
  const balance = useBalance();
  const value = balance.data?.balance ?? me?.balance;
  const negative = value !== undefined && toNumber(value) < 0;
  return (
    <section className={negative ? 'card balance-card is-negative' : 'card balance-card'}>
      <div className="balance-card-head">
        <h2>Баланс</h2>
        <span className="stat-icon" aria-hidden="true">
          <IconWallet />
        </span>
      </div>
      {balance.isLoading && !value ? (
        <p className="hero skeleton-text" aria-busy="true">
          <span className="sr-only">Загрузка…</span>
        </p>
      ) : (
        <p className={negative ? 'hero hero-neg mono' : 'hero mono'} data-testid="balance">
          {formatMoneyPrecise(value)}
        </p>
      )}
      <ErrorNote error={balance.error} />
      {negative && (
        <div className="alert alert-warn">
          Баланс отрицательный: работающие инстансы будут остановлены. Пополните баланс.
        </div>
      )}
      <p className="muted small">Списания идут посекундно, пока инстанс работает или хранится том.</p>
    </section>
  );
}

function TopUpCard() {
  const toast = useToast();
  const create = useCreatePayment();
  const pay = useDemoPay();
  const [amount, setAmount] = useState('1000');
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentCreated | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const err = validateAmount(amount);
    setError(err);
    if (err) return;
    create.mutate(Number(amount.replace(',', '.')), { onSuccess: setPayment });
  }

  function demoPay(p: PaymentCreated) {
    pay.mutate(p.payment.id, {
      onSuccess: () => {
        toast(`Баланс пополнен на ${formatMoney(p.payment.amount)}`);
        setPayment(null);
      },
    });
  }

  return (
    <section className="card">
      <h2>Пополнение</h2>
      {payment ? (
        <div className="stack">
          <p>
            Платёж № {payment.payment.id} на сумму <strong>{formatMoney(payment.payment.amount)}</strong> создан.
          </p>
          <p className="muted small">
            Демо-режим: настоящий платёжный шлюз не подключён, деньги не списываются с карты. Кнопка ниже имитирует
            уведомление шлюза об успешной оплате.
          </p>
          <ErrorNote error={pay.error} />
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={pay.isPending} onClick={() => demoPay(payment)}>
              {pay.isPending ? 'Оплачиваем…' : 'Оплатить (демо)'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={pay.isPending}
              onClick={() => {
                pay.reset();
                setPayment(null);
              }}
            >
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          <Field label="Сумма, ₽" error={error}>
            <input
              name="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={!!error}
            />
          </Field>
          <div className="chips" role="group" aria-label="Быстрые суммы">
            {QUICK_AMOUNTS.map((a) => (
              <button
                type="button"
                key={a}
                className="chip"
                aria-pressed={amount === String(a)}
                onClick={() => setAmount(String(a))}
              >
                {formatMoney(a).replace(',00', '')}
              </button>
            ))}
          </div>
          <ErrorNote error={create.error} />
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём платёж…' : 'Пополнить'}
          </button>
        </form>
      )}
    </section>
  );
}

const PERIODS = [
  { days: 7, label: '7 дней' },
  { days: 30, label: '30 дней' },
  { days: 90, label: '90 дней' },
];

function SpendSection() {
  const [days, setDays] = useState(30);
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - (days - 1));
    return { from: toDateInput(from), to: toDateInput(to), start: from };
  }, [days]);
  const spend = useSpend(range.from, range.to);

  // Дни без расходов тоже рисуем (нулевые), чтобы ось времени была непрерывной
  const bars = useMemo(() => {
    const byDay = new Map((spend.data?.byDay ?? []).map((d) => [d.day.slice(0, 10), toNumber(d.amount)]));
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(range.start);
      d.setDate(d.getDate() + i);
      const key = toDateInput(d);
      return { label: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`, title: formatDate(key), value: byDay.get(key) ?? 0 };
    });
  }, [spend.data, days, range.start]);

  return (
    <section className="card section">
      <div className="section-head">
        <h2>Расходы за период</h2>
        <div className="seg" role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <button
              type="button"
              key={p.days}
              className={days === p.days ? 'seg-btn active' : 'seg-btn'}
              aria-pressed={days === p.days}
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <QueryState isLoading={spend.isLoading} error={spend.error} onRetry={() => void spend.refetch()} />
      {spend.data && (
        <div className={spend.isFetching ? 'dim' : undefined}>
          <p className="spend-total">
            <span className="muted">Всего за период</span>
            <strong className="mono">{formatMoneyPrecise(spend.data.total)}</strong>
          </p>
          <BarChart
            data={bars}
            format={(n) => formatMoneyPrecise(n)}
            ariaLabel={`Расходы по дням за последние ${days} дней`}
            valueTitle="Расход"
          />
          {spend.data.byInstance.length > 0 && (
            <>
              <h3>По инстансам</h3>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Инстанс</th>
                      <th className="num">Расход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spend.data.byInstance.map((r) => (
                      <tr key={r.instanceId}>
                        <td>
                          <Link to={`/instances/${r.instanceId}`}>{r.name}</Link>
                        </td>
                        <td className="num mono">{formatMoneyPrecise(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function TransactionsSection() {
  const tx = useTransactions();
  const rows = tx.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="card section">
      <h2>История операций</h2>
      <QueryState isLoading={tx.isLoading} error={tx.error} onRetry={() => void tx.refetch()} />
      {tx.data && rows.length === 0 && (
        <Empty title="Операций пока нет" icon={<IconWallet size={28} />}>
          Пополните баланс, чтобы запустить инстанс.
        </Empty>
      )}
      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="table responsive" data-testid="tx-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Операция</th>
                <th>Описание</th>
                <th className="num">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const amount = toNumber(t.amount);
                return (
                  <tr key={t.id} data-type={t.type}>
                    <td data-label="Дата" className="nowrap muted">
                      {formatDateTime(t.createdAt)}
                    </td>
                    <td data-label="Операция">
                      <span className={`tx-type tx-${t.type}`}>{TX_LABEL[t.type] ?? t.type}</span>
                    </td>
                    <td data-label="Описание" className="break">
                      {t.description || '—'}
                    </td>
                    <td data-label="Сумма" className={amount < 0 ? 'num mono neg' : 'num mono pos'}>
                      {amount > 0 ? '+' : ''}
                      {formatMoneyPrecise(amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {tx.hasNextPage && (
        <div className="row center">
          <button type="button" className="btn" disabled={tx.isFetchingNextPage} onClick={() => void tx.fetchNextPage()}>
            {tx.isFetchingNextPage ? 'Загрузка…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </section>
  );
}

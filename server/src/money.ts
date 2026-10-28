// Деньги — десятичные строки с четырьмя знаками ("1234.5600"), как numeric(14,4) в БД.
// Арифметика на целых (BigInt) в единицах 0,0001 ₽: числа с плавающей точкой для денег не используются.

const SCALE = 4;

export function toUnits(amount: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Неверная денежная сумма: ${amount}`);
  const units = BigInt(m[2]!) * 10n ** BigInt(SCALE) + BigInt((m[3] ?? '').padEnd(SCALE, '0'));
  return m[1] === '-' ? -units : units;
}

export function fromUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const base = 10n ** BigInt(SCALE);
  return `${sign}${abs / base}.${(abs % base).toString().padStart(SCALE, '0')}`;
}

/** Стоимость часа работы инстанса: цена одной GPU в час * число GPU (так же считает _fn_quote_instance в БД). */
export function hourlyCost(pricePerGpuHour: string, gpuCount: number): string {
  if (!Number.isInteger(gpuCount) || gpuCount < 1) throw new Error('gpuCount должен быть целым числом больше нуля');
  return fromUnits(toUnits(pricePerGpuHour) * BigInt(gpuCount));
}

/** Стоимость p секунд работы по часовой цене с округлением до 0,0001 (как round(price * seconds / 3600, 4) в БД). */
export function costForSeconds(pricePerHour: string, seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error('seconds должно быть целым неотрицательным числом');
  const product = toUnits(pricePerHour) * BigInt(seconds);
  return fromUnits((product * 2n + 3600n) / 7200n); // округление половины вверх без плавающей точки
}

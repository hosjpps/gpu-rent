import { describe, expect, it } from 'vitest';
import { costForSeconds, fromUnits, hourlyCost, toUnits } from '../../src/money';

describe('toUnits / fromUnits', () => {
  it('переводит строку в целые единицы по 0,0001 и обратно', () => {
    expect(toUnits('1234.5600')).toBe(12_345_600n);
    expect(toUnits('5')).toBe(50_000n);
    expect(toUnits('0.0001')).toBe(1n);
    expect(toUnits('7.5')).toBe(75_000n);
    expect(fromUnits(12_345_600n)).toBe('1234.5600');
    expect(fromUnits(1n)).toBe('0.0001');
    expect(fromUnits(0n)).toBe('0.0000');
  });

  it('работает с отрицательными суммами (долг)', () => {
    expect(toUnits('-80.2572')).toBe(-802_572n);
    expect(fromUnits(-802_572n)).toBe('-80.2572');
    expect(fromUnits(-5n)).toBe('-0.0005');
    expect(toUnits('-0.0005')).toBe(-5n);
  });

  it('не теряет точность там, где double уже ошибся бы', () => {
    // numeric(14,4) вмещает 99999999999999.9999, а в double это число не представимо точно
    expect(fromUnits(toUnits('99999999999999.9999'))).toBe('99999999999999.9999');
    expect(fromUnits(toUnits('0.1') + toUnits('0.2'))).toBe('0.3000');
  });

  it.each(['', 'abc', '1,5', '.5', '1.', '1.23456', '--1', '1e3', ' '])('отвергает %j', (bad) => {
    expect(() => toUnits(bad)).toThrow(/Неверная денежная сумма/);
  });

  it('допускает пробелы по краям', () => {
    expect(toUnits('  12.3 ')).toBe(123_000n);
  });
});

describe('hourlyCost', () => {
  it('цена одной GPU в час умножается на число GPU', () => {
    expect(hourlyCost('49.4400', 1)).toBe('49.4400');
    expect(hourlyCost('49.4400', 2)).toBe('98.8800');
    expect(hourlyCost('535.6000', 8)).toBe('4284.8000');
    expect(hourlyCost('0.0001', 3)).toBe('0.0003');
  });

  it.each([0, -1, 1.5, Number.NaN])('число GPU %s недопустимо', (n) => {
    expect(() => hourlyCost('10.0000', n)).toThrow();
  });
});

describe('costForSeconds', () => {
  it('целый час, половина часа, минута', () => {
    expect(costForSeconds('120.0000', 3600)).toBe('120.0000');
    expect(costForSeconds('120.0000', 1800)).toBe('60.0000');
    expect(costForSeconds('120.0000', 60)).toBe('2.0000');
    expect(costForSeconds('120.0000', 0)).toBe('0.0000');
  });

  it('округляет до 0,0001 так же, как round(price * seconds / 3600, 4) в БД: половина вверх', () => {
    expect(costForSeconds('0.0001', 1800)).toBe('0.0001'); // ровно 0,00005 -> вверх
    expect(costForSeconds('0.0001', 1799)).toBe('0.0000'); // чуть меньше половины -> вниз
    expect(costForSeconds('1.0000', 1)).toBe('0.0003'); // 0,000277... -> 0,0003
    expect(costForSeconds('77.2500', 4321)).toBe('92.7215'); // 92,721458... -> вверх
  });

  it('сутки работы на дорогой GPU', () => {
    expect(costForSeconds('535.6000', 86_400)).toBe('12854.4000');
  });

  it.each([-1, 1.5, Number.NaN])('секунды %s недопустимы', (s) => {
    expect(() => costForSeconds('10.0000', s)).toThrow();
  });
});

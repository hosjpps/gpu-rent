import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../src/cursor';
import { AppError } from '../../src/errors';

const schema = z.object({ t: z.string(), id: z.number().int().positive() });

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(400);
    expect((e as AppError).code).toBe('INVALID_CURSOR');
    return;
  }
  throw new Error('ожидалась ошибка INVALID_CURSOR');
}

describe('курсор keyset-пагинации', () => {
  it('кодирует и декодирует без потерь, включая микросекунды и кириллицу', () => {
    const payload = { t: '2026-10-28T12:00:00.123456Z', id: 42 };
    expect(decodeCursor(encodeCursor(payload), schema)).toEqual(payload);
    const ru = { t: 'привет', id: 1 };
    expect(decodeCursor(encodeCursor(ru), schema)).toEqual(ru);
  });

  it('строка пригодна для URL: только символы base64url', () => {
    const c = encodeCursor({ t: '???>>>~~~', id: 7 });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('мусор вместо курсора — INVALID_CURSOR', () => {
    expectInvalid(() => decodeCursor('', schema));
    expectInvalid(() => decodeCursor('###', schema));
    expectInvalid(() => decodeCursor('not-json', schema));
    expectInvalid(() => decodeCursor(Buffer.from('{"t":').toString('base64url'), schema));
  });

  it('JSON не по схеме — INVALID_CURSOR: содержимому курсора доверия нет', () => {
    expectInvalid(() => decodeCursor(encodeCursor({ t: 'x', id: -1 }), schema));
    expectInvalid(() => decodeCursor(encodeCursor({ t: 'x' } as never), schema));
    expectInvalid(() => decodeCursor(Buffer.from('"строка"').toString('base64url'), schema));
    expectInvalid(() => decodeCursor(Buffer.from('null').toString('base64url'), schema));
  });
});

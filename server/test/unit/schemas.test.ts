import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors';
import {
  apiKeyBody,
  changePasswordBody,
  createInstanceBody,
  createPaymentBody,
  createVolumeBody,
  decimalSchema,
  extendVolumeBody,
  idParams,
  idSchema,
  limitSchema,
  loginBody,
  nodeStatusBody,
  parse,
  parseSshPublicKey,
  registerBody,
  setPriceBody,
  sshKeyBody,
  uuidParams,
  verifyBody,
} from '../../src/schemas';
import { makeEcdsaKey, makeRsaKey, makeSshKey } from '../support/ssh';

const ok = (schema: z.ZodTypeAny, data: unknown) => schema.safeParse(data).success;

const validRegister = { email: 'user@example.com', password: 'longenough1', fullName: 'Иван Петров' };
const validInstance = {
  name: 'train-1',
  datacenterCode: 'MSK-1',
  gpuModel: 'RTX 4090',
  gpuCount: 2,
  pricingType: 'on_demand',
  templateId: 1,
};

describe('parse()', () => {
  it('возвращает разобранные данные', () => {
    expect(parse(z.object({ a: z.number() }), { a: 1 })).toEqual({ a: 1 });
  });

  it('при ошибке бросает AppError 400 VALIDATION_ERROR с перечнем полей по-русски', () => {
    try {
      parse(registerBody, { email: 'bad', password: 'short' });
      throw new Error('не бросило');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.status).toBe(400);
      expect(err.code).toBe('VALIDATION_ERROR');
      const details = err.details as { path: string; message: string }[];
      expect(details.map((d) => d.path).sort()).toEqual(['email', 'fullName', 'password']);
      expect(details.find((d) => d.path === 'fullName')?.message).toBe('Обязательное поле');
      expect(details.find((d) => d.path === 'password')?.message).toBe('Пароль должен быть не короче 8 символов');
    }
  });

  it('лишнее поле в strict-схеме отклоняется с понятным сообщением', () => {
    try {
      parse(registerBody, { ...validRegister, role: 'admin' });
      throw new Error('не бросило');
    } catch (e) {
      const details = (e as AppError).details as { message: string }[];
      expect(details[0]?.message).toBe('Лишние поля в запросе');
    }
  });
});

describe('регистрация и вход', () => {
  it('нормализует email: пробелы по краям и регистр', () => {
    expect(registerBody.parse({ ...validRegister, email: '  User@Example.COM ' }).email).toBe('user@example.com');
  });

  it('обрезает пробелы в имени', () => {
    expect(registerBody.parse({ ...validRegister, fullName: '  Иван  ' }).fullName).toBe('Иван');
  });

  it.each(['role', 'status', 'balance', 'isAdmin', 'id', 'emailVerified'])('поле %s из тела не принимается (нельзя назначить себе права)', (field) => {
    expect(ok(registerBody, { ...validRegister, [field]: field === 'balance' ? '1000' : 'x' })).toBe(false);
  });

  it.each(['a', 'a@b', 'a b@c.d', '@x.y', 'a@@b.c', 'a@b.', '', 'user@exam ple.com'])('email %j отвергается', (email) => {
    expect(ok(registerBody, { ...validRegister, email })).toBe(false);
  });

  it('длинный email с множеством точек разбирается быстро (нет ReDoS)', () => {
    for (const email of [`a@${'.'.repeat(30000)}@`, `a@${'.'.repeat(250)}@`, `${'a'.repeat(30000)}@b.c`]) {
      const t = performance.now();
      expect(ok(registerBody, { ...validRegister, email })).toBe(false);
      expect(performance.now() - t).toBeLessThan(50);
    }
  });

  it('слишком длинный email отвергается', () => {
    expect(ok(registerBody, { ...validRegister, email: `${'a'.repeat(250)}@x.io` })).toBe(false);
  });

  it('пароль: 8 символов можно, 7 нельзя', () => {
    expect(ok(registerBody, { ...validRegister, password: '12345678' })).toBe(true);
    expect(ok(registerBody, { ...validRegister, password: '1234567' })).toBe(false);
  });

  it('пароль считается в байтах: bcrypt учитывает только первые 72', () => {
    expect(ok(registerBody, { ...validRegister, password: 'a'.repeat(72) })).toBe(true);
    expect(ok(registerBody, { ...validRegister, password: 'a'.repeat(73) })).toBe(false);
    // 40 кириллических букв = 80 байт, хотя символов меньше 72
    expect(ok(registerBody, { ...validRegister, password: 'ж'.repeat(40) })).toBe(false);
    expect(ok(registerBody, { ...validRegister, password: 'ж'.repeat(36) })).toBe(true);
  });

  it('имя: от 2 до 120 символов', () => {
    expect(ok(registerBody, { ...validRegister, fullName: 'И' })).toBe(false);
    expect(ok(registerBody, { ...validRegister, fullName: 'И'.repeat(121) })).toBe(false);
    expect(ok(registerBody, { ...validRegister, fullName: 'И'.repeat(120) })).toBe(true);
  });

  it('вход: пароль не пустой и не огромный, лишних полей нет', () => {
    expect(ok(loginBody, { email: 'a@b.cc', password: 'x' })).toBe(true);
    expect(ok(loginBody, { email: 'a@b.cc', password: '' })).toBe(false);
    expect(ok(loginBody, { email: 'a@b.cc', password: 'x'.repeat(201) })).toBe(false);
    expect(ok(loginBody, { email: 'a@b.cc', password: 'x', remember: true })).toBe(false);
  });

  it('смена пароля: новый пароль проходит те же правила', () => {
    expect(ok(changePasswordBody, { currentPassword: 'old', newPassword: 'newpassword' })).toBe(true);
    expect(ok(changePasswordBody, { currentPassword: 'old', newPassword: 'short' })).toBe(false);
    expect(ok(changePasswordBody, { currentPassword: '', newPassword: 'newpassword' })).toBe(false);
    expect(ok(changePasswordBody, { currentPassword: 'old', newPassword: 'newpassword', userId: 1 })).toBe(false);
  });

  it('токен подтверждения email: 20..200 символов', () => {
    expect(ok(verifyBody, { token: 'x'.repeat(43) })).toBe(true);
    expect(ok(verifyBody, { token: 'x'.repeat(19) })).toBe(false);
    expect(ok(verifyBody, { token: 'x'.repeat(201) })).toBe(false);
    expect(ok(verifyBody, {})).toBe(false);
  });
});

describe('идентификаторы и пагинация', () => {
  it('idSchema: положительное целое, строка из пути приводится к числу', () => {
    expect(idSchema.parse('5')).toBe(5);
    expect(idSchema.parse(7)).toBe(7);
    for (const bad of ['0', '-1', '1.5', 'abc', '', '9007199254740993', null]) expect(ok(idSchema, bad)).toBe(false);
  });

  it('idParams / uuidParams', () => {
    expect(idParams.parse({ id: '12' })).toEqual({ id: 12 });
    expect(ok(idParams, { id: 'DROP TABLE' })).toBe(false);
    expect(ok(uuidParams, { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' })).toBe(true);
    expect(ok(uuidParams, { id: 'not-a-uuid' })).toBe(false);
    expect(ok(uuidParams, { id: '1' })).toBe(false);
  });

  it('limitSchema: по умолчанию 20, от 1 до 100', () => {
    expect(limitSchema.parse(undefined)).toBe(20);
    expect(limitSchema.parse('100')).toBe(100);
    expect(ok(limitSchema, '0')).toBe(false);
    expect(ok(limitSchema, '101')).toBe(false);
    expect(ok(limitSchema, 'abc')).toBe(false);
    expect(ok(limitSchema, '1.5')).toBe(false);
  });
});

describe('суммы (decimalSchema)', () => {
  const amount = decimalSchema(2, 10, 100_000);

  it('принимает строку и число, обрезает пробелы, возвращает строку', () => {
    expect(amount.parse('10')).toBe('10');
    expect(amount.parse(' 25.5 ')).toBe('25.5');
    expect(amount.parse(500)).toBe('500');
    expect(amount.parse('100000.00')).toBe('100000.00');
  });

  it.each(['9.99', '9', '100000.01', '100001', '10.123', '-50', '1e3', '', ' ', 'abc', '1,5', '10.', '.5', '0x10', '1234567890'])('отвергает %j', (bad) => {
    expect(ok(amount, bad)).toBe(false);
  });

  it('число, строка-число и NaN/null/объект', () => {
    expect(ok(amount, Number.NaN)).toBe(false);
    expect(ok(amount, null)).toBe(false);
    expect(ok(amount, {})).toBe(false);
    expect(ok(amount, 10.123)).toBe(false);
  });

  it('createPaymentBody: только amount, userId и status запрещены', () => {
    expect(createPaymentBody.parse({ amount: 500 })).toEqual({ amount: '500' });
    expect(ok(createPaymentBody, { amount: 500, userId: 2 })).toBe(false);
    expect(ok(createPaymentBody, { amount: 500, status: 'succeeded' })).toBe(false);
    expect(ok(createPaymentBody, {})).toBe(false);
    expect(ok(createPaymentBody, { amount: 5 })).toBe(false);
  });
});

describe('SSH-ключи', () => {
  it('разбирает настоящий ключ ed25519 и считает отпечаток', () => {
    const k = makeSshKey('me@laptop');
    const parsed = parseSshPublicKey(k.publicKey);
    expect(parsed?.fingerprint).toBe(k.fingerprint);
    expect(parsed?.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(parsed?.normalized).toBe(k.publicKey);
  });

  it('ключ без комментария и с переводом строки в конце', () => {
    const k = makeSshKey();
    const bare = `ssh-ed25519 ${k.blob}`;
    expect(parseSshPublicKey(`${bare}\n`)?.normalized).toBe(bare);
  });

  it('отвергает мусор, неподдерживаемые типы и ключ, где тип снаружи не совпадает с типом внутри', () => {
    const k = makeSshKey();
    expect(parseSshPublicKey('hello world')).toBeNull();
    expect(parseSshPublicKey('')).toBeNull();
    expect(parseSshPublicKey(`ssh-dss ${k.blob}`)).toBeNull();
    expect(parseSshPublicKey(`ssh-rsa ${k.blob}`)).toBeNull(); // внутри blob написано ssh-ed25519
    expect(parseSshPublicKey('ssh-ed25519 AAAA')).toBeNull(); // слишком короткий blob
    expect(parseSshPublicKey(`ssh-ed25519  ${k.blob}`)).toBeNull(); // два пробела
    expect(parseSshPublicKey(`ssh-ed25519 ${k.blob}!!!`)).toBeNull();
  });

  it('принимает настоящие ключи ssh-rsa и ecdsa-sha2-nistp256', () => {
    for (const k of [makeRsaKey(), makeEcdsaKey()]) {
      const parsed = parseSshPublicKey(k.publicKey);
      expect(parsed).not.toBeNull();
      expect(parsed?.fingerprint).toMatch(/^SHA256:/);
    }
  });

  it('обрезанный или с лишним хвостом ключ не принимается: поля должны точно уложиться в blob', () => {
    const rsa = makeRsaKey();
    const blob = Buffer.from(rsa.blob, 'base64');
    expect(parseSshPublicKey(`ssh-rsa ${blob.subarray(0, 40).toString('base64')}`)).toBeNull(); // обрезан посреди модуля
    expect(parseSshPublicKey(`ssh-rsa ${blob.subarray(0, 23).toString('base64')}`)).toBeNull(); // есть тип и экспонента, модуля нет
    expect(parseSshPublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ')).toBeNull();
    const ed = Buffer.from(makeSshKey().blob, 'base64');
    expect(parseSshPublicKey(`ssh-ed25519 ${Buffer.concat([ed, Buffer.from('хвост')]).toString('base64')}`)).toBeNull();
    expect(parseSshPublicKey(`ssh-ed25519 ${ed.subarray(0, ed.length - 1).toString('base64')}`)).toBeNull();
  });

  it('sshKeyBody: имя и ключ обязательны, лишние поля нельзя', () => {
    const k = makeSshKey();
    expect(ok(sshKeyBody, { name: 'laptop', publicKey: k.publicKey })).toBe(true);
    expect(ok(sshKeyBody, { name: '', publicKey: k.publicKey })).toBe(false);
    expect(ok(sshKeyBody, { name: 'x'.repeat(65), publicKey: k.publicKey })).toBe(false);
    expect(ok(sshKeyBody, { name: 'laptop', publicKey: 'short' })).toBe(false);
    expect(ok(sshKeyBody, { name: 'laptop', publicKey: k.publicKey, userId: 1 })).toBe(false);
  });
});

describe('API-ключи', () => {
  it('срок действия должен быть в будущем и в формате ISO с часовым поясом', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(ok(apiKeyBody, { name: 'ci' })).toBe(true);
    expect(ok(apiKeyBody, { name: 'ci', expiresAt: future })).toBe(true);
    expect(ok(apiKeyBody, { name: 'ci', expiresAt: past })).toBe(false);
    expect(ok(apiKeyBody, { name: 'ci', expiresAt: 'tomorrow' })).toBe(false);
    expect(ok(apiKeyBody, { name: 'ci', expiresAt: '2099-01-01' })).toBe(false);
    expect(ok(apiKeyBody, { name: '', expiresAt: future })).toBe(false);
    expect(ok(apiKeyBody, { name: 'ci', userId: 5 })).toBe(false);
  });
});

describe('запуск инстанса', () => {
  it('минимальный корректный запрос', () => {
    expect(ok(createInstanceBody, validInstance)).toBe(true);
  });

  it('число GPU от 1 до 8, только целое число (не строка)', () => {
    expect(ok(createInstanceBody, { ...validInstance, gpuCount: 0 })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, gpuCount: 9 })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, gpuCount: 1.5 })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, gpuCount: '2' })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, gpuCount: 8 })).toBe(true);
  });

  it('тип тарификации только on_demand или spot', () => {
    expect(ok(createInstanceBody, { ...validInstance, pricingType: 'spot' })).toBe(true);
    expect(ok(createInstanceBody, { ...validInstance, pricingType: 'reserved' })).toBe(false);
  });

  it('шаблон, том и ключ — положительные id', () => {
    expect(ok(createInstanceBody, { ...validInstance, templateId: 0 })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, volumeId: -1 })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, volumeId: 3, sshKeyId: 4 })).toBe(true);
  });

  it('диск контейнера 10..2000 ГБ', () => {
    expect(ok(createInstanceBody, { ...validInstance, containerDiskGb: 9 })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, containerDiskGb: 2001 })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, containerDiskGb: 100 })).toBe(true);
  });

  it('код дата-центра: буквы, цифры и дефис', () => {
    for (const code of ['x', 'MSK 1', "MSK-1'; --", 'a'.repeat(17)]) expect(ok(createInstanceBody, { ...validInstance, datacenterCode: code })).toBe(false);
  });

  it('переменные окружения: имена как у shell, значения строками, не больше 30', () => {
    expect(ok(createInstanceBody, { ...validInstance, env: { HF_TOKEN: 'abc', _X1: 'y' } })).toBe(true);
    expect(ok(createInstanceBody, { ...validInstance, env: { 'BAD-NAME': 'x' } })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, env: { '1X': 'x' } })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, env: { A: 5 } })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, env: { A: 'x'.repeat(2001) } })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`V${i}`, 'x']));
    expect(ok(createInstanceBody, { ...validInstance, env: many })).toBe(false);
    expect(ok(createInstanceBody, { ...validInstance, env: Object.fromEntries(Object.entries(many).slice(0, 30)) })).toBe(true);
  });

  it.each(['userId', 'status', 'price', 'pricePerHour', 'nodeId', 'gpuIds'])('лишнее поле %s отвергается', (field) => {
    expect(ok(createInstanceBody, { ...validInstance, [field]: 1 })).toBe(false);
  });
});

describe('тома, цены, узлы', () => {
  it('размер тома 10..10000 ГБ, целое', () => {
    const vol = { name: 'data', datacenterCode: 'MSK-1', sizeGb: 100 };
    expect(ok(createVolumeBody, vol)).toBe(true);
    expect(ok(createVolumeBody, { ...vol, sizeGb: 9 })).toBe(false);
    expect(ok(createVolumeBody, { ...vol, sizeGb: 10_001 })).toBe(false);
    expect(ok(createVolumeBody, { ...vol, sizeGb: 100.5 })).toBe(false);
    expect(ok(createVolumeBody, { ...vol, userId: 1 })).toBe(false);
    expect(ok(extendVolumeBody, { sizeGb: 200 })).toBe(true);
    expect(ok(extendVolumeBody, { sizeGb: 5 })).toBe(false);
    expect(ok(extendVolumeBody, { sizeGb: 200, name: 'x' })).toBe(false);
  });

  it('новая цена: от 0,01 до 100000, не больше 4 знаков', () => {
    const price = { datacenterCode: 'NSK-1', gpuModel: 'RTX 3090', pricingType: 'spot', pricePerHour: '26.5' };
    expect(ok(setPriceBody, price)).toBe(true);
    expect(ok(setPriceBody, { ...price, pricePerHour: 26.5 })).toBe(true);
    expect(ok(setPriceBody, { ...price, pricePerHour: '0.0001' })).toBe(false);
    expect(ok(setPriceBody, { ...price, pricePerHour: '0.01' })).toBe(true);
    expect(ok(setPriceBody, { ...price, pricePerHour: '10.12345' })).toBe(false);
    expect(ok(setPriceBody, { ...price, pricePerHour: '-5' })).toBe(false);
    expect(ok(setPriceBody, { ...price, pricePerHour: '100000.01' })).toBe(false);
    expect(ok(setPriceBody, { ...price, pricingType: 'free' })).toBe(false);
    expect(ok(setPriceBody, { ...price, id: 1 })).toBe(false);
  });

  it('статус узла из трёх допустимых', () => {
    for (const s of ['online', 'maintenance', 'offline']) expect(ok(nodeStatusBody, { status: s })).toBe(true);
    expect(ok(nodeStatusBody, { status: 'broken' })).toBe(false);
    expect(ok(nodeStatusBody, {})).toBe(false);
  });
});

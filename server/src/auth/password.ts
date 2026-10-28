import bcrypt from 'bcryptjs';

// Хэш случайной строки, пароль к нему никто не знает. Сравнение с ним выравнивает время ответа входа
// для существующего и несуществующего email, чтобы по скорости ответа нельзя было перебирать адреса.
const DUMMY_HASH = '$2b$12$vKowoqbcqHGpGJ50s5FuDe.kQkZibg56ZclFZ68rF1LvCfaJvNeAy';

export const hashPassword = (password: string, cost: number): Promise<string> => bcrypt.hash(password, cost);

export async function verifyPassword(password: string, hash: string | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return hash !== undefined && ok;
}

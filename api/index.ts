import { createApp } from '../server/src/app';

// Вход для Vercel: платформа вызывает экспортированное Express-приложение как обработчик (req, res).
// listen здесь не нужен, а createApp() ничего не делает при импорте, кроме чтения окружения:
// соединение с БД откроется только при первом запросе. Локально сервер запускает server/src/index.ts.
export default createApp();

import { createApp } from './app';
import { closePool } from './db';

// Локальный запуск. На Vercel используется api/index.ts, а этот файл не нужен.
const app = createApp();
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, () => {
  console.log(`GPU Rent API: http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      closePool().finally(() => process.exit(0));
    });
  });
}

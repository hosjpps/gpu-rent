import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке запросы /api уходят на локальный сервер (server/, порт 3001),
// поэтому браузер видит один origin и cookie сессии работает без CORS.
// API_URL позволяет направить прокси на сервер с другим портом.
// changeOrigin выключен намеренно: сервер сверяет Origin с заголовком Host (защита от CSRF),
// а при подмене Host на адрес API проверка отвергала бы все запросы из браузера.
const proxy = { '/api': { target: process.env.API_URL ?? 'http://localhost:3001', changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        // React и роутер меняются редко: отдельный чанк кэшируется браузером между релизами
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// CodeLens 构建配置：React + Tailwind + Vitest（浏览器本地运行，无后端依赖）
export default defineConfig({
  // 使用相对路径，保证 GitHub Pages 的 /CodeLens/ 子路径下资源也能正确加载
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    reporters: ['default'],
  },
});

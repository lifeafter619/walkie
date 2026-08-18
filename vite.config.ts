import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      // 注意：Vite 会把裸的 '/api' 前缀当成请求路径匹配，从而误拦截模块文件 /api.ts。
      // 用正则锚定到路径边界，仅代理 /api/* 与 /api，保留 /api.ts 等静态模块给 Vite 处理。
      '^/api(/|$)': `http://127.0.0.1:${process.env.API_PORT ?? '4310'}`,
      '/health': `http://127.0.0.1:${process.env.API_PORT ?? '4310'}`
    }
  }
});

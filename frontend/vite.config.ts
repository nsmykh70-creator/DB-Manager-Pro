import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendUrl = env.VITE_API_PROXY || 'http://localhost:3001';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api': backendUrl
      }
    }
  };
});

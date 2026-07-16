import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        // Silence ONLY the "Use of eval" warning from the vendored gapi-script
        // package (Google's minified platform script has a legacy JSON-parse
        // fallback that uses eval; it's third-party dead-code, not our app code).
        // Every other warning still passes through to Rollup's default handler.
        onwarn(warning, warn) {
          const file = warning.id || warning.loc?.file || '';
          if (warning.code === 'EVAL' && /gapi-script/.test(file)) return;
          warn(warning);
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

import path from 'path';
import fs from 'fs';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import viteCompression from 'vite-plugin-compression';

function generateBuildVersion(): Plugin {
  const buildVersion = Date.now().toString();
  return {
    name: 'generate-build-version',
    buildStart() {
      console.log(`Build version: ${buildVersion}`);
    },
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `<meta name="build-version" content="${buildVersion}" /></head>`
      );
    },
    writeBundle() {
      const swPath = path.resolve(__dirname, 'dist/sw.js');
      if (fs.existsSync(swPath)) {
        let swContent = fs.readFileSync(swPath, 'utf-8');
        swContent = swContent.replace('__BUILD_VERSION__', buildVersion);
        fs.writeFileSync(swPath, swContent);
      }
    }
  };
}

export default defineConfig({
  server: {
    port: 5000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            console.log('[Vite Proxy] API proxy error (backend may be starting):', err.message);
          });
        },
      },
      '/healthz': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            console.log('[Vite Proxy] Health check proxy error (backend may be starting):', err.message);
          });
        },
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err, req, res) => {
            console.log('[Vite Proxy] WebSocket proxy error (backend may be starting):', err.message);
          });
        },
      }
    },
    watch: {
      ignored: ['**/.cache/**', '**/node_modules/**']
    }
  },
  plugins: [
    react(),
    generateBuildVersion(),
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 1024,
    }),
    viteCompression({
      algorithm: 'brotliCompress',
      ext: '.br',
      threshold: 1024,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@assets': path.resolve(__dirname, 'attached_assets'),
    }
  },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(process.env.SUPABASE_URL),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(process.env.SUPABASE_ANON_KEY),
    'import.meta.env.VITE_SCREENSHOT_TOKEN': JSON.stringify(process.env.SCREENSHOT_TOKEN || ''),
    'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(process.env.GOOGLE_CLIENT_ID || ''),
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react-dom')) {
              return 'vendor-react-dom';
            }
            if (id.includes('react-router')) {
              return 'vendor-react-router';
            }
            if (id.includes('@supabase')) {
              return 'vendor-supabase';
            }
            if (id.includes('zustand') || id.includes('zod')) {
              return 'vendor-utils';
            }
          }
        },
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
      }
    }
  }
});

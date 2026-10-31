import { defineConfig } from '../../solana-launcher/node_modules/vite/dist/node/index.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '../../solana-launcher/node_modules/tailwindcss/lib/index.js';
import autoprefixer from '../../solana-launcher/node_modules/autoprefixer/lib/autoprefixer.js';
import loadConfig from '../../solana-launcher/node_modules/tailwindcss/loadConfig.js';

const ui = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.resolve(ui, '../../solana-launcher');
export default defineConfig({
  root: ui,
  base: '/static/collector-workspaces/',
  resolve: { alias: [
    { find: 'next/link', replacement: path.join(ui, 'next-link.tsx') },
    { find: 'next/image', replacement: path.join(ui, 'next-image.tsx') },
    { find: '@/lib/clientAuth', replacement: path.join(ui, 'client-auth.ts') },
    { find: '@', replacement: launcher },
    ...['react', 'react-dom', 'react-window', 'lucide-react'].map(name => ({ find: new RegExp(`^${name}(/.*)?$`), replacement: path.join(launcher, 'node_modules', name) + '$1' })),
  ], dedupe: ['react', 'react-dom'] },
  esbuild: { jsx: 'automatic' },
  css: { postcss: { plugins: [tailwind({
    ...loadConfig(path.join(launcher, 'tailwind.config.ts')),
    content: [path.join(launcher, 'app/settings/**/*.tsx'), path.join(launcher, 'components/tginvite/**/*.tsx'), path.join(launcher, 'lib/siteDesign.ts'), path.join(ui, '*.tsx')],
  }), autoprefixer()] } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env.NEXT_PUBLIC_BACKEND_URL': JSON.stringify('/') },
  build: { outDir: path.resolve(ui, '../app/static/collector-workspaces'), emptyOutDir: true, sourcemap: false,
    rolldownOptions: { onwarn(warning, warn) { if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning); } },
  },
});

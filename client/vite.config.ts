import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { version } from './package.json'

const pkgVersion: string = version
const buildTime: string = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  base: './',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: false,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari14',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
  },
})

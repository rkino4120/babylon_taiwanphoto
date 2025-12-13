import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// pre-bundle heavy deps (reduces optimizeDeps re-bundling during dev)
const preBundleDeps = [
  '@babylonjs/core',
  '@babylonjs/loaders',
  '@babylonjs/gui'
];

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: preBundleDeps,
  },
})

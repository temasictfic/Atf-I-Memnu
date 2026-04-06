import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: []
      },
      rollupOptions: {
        external: ['fsevents']
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: []
      },
      rollupOptions: {
        external: ['fsevents']
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    root: './src/renderer',
    build: {
      rollupOptions: {
        input: './src/renderer/index.html'
      }
    }
  }
})

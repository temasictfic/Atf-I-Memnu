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
        external: ['fsevents'],
        input: {
          index: 'src/preload/index.ts',
          'scholar-preload': 'src/preload/scholar-preload.ts'
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
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

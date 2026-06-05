import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer')
      }
    },
    base: './',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          dashboard: resolve(__dirname, 'src/renderer/dashboard.html'),
          onboarding: resolve(__dirname, 'src/renderer/onboarding.html'),
          'private-chat': resolve(__dirname, 'src/renderer/private-chat.html')
        }
      }
    }
  }
})

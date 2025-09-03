import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'


export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'VueQrScanner',
      fileName: (format) => `vue-smart-qr-scanner.${format}.js`
    },
    rollupOptions: {
      external: ['vue'],
      output: {
        globals: { vue: 'Vue' }
      }
    },
    sourcemap: true
  }
})

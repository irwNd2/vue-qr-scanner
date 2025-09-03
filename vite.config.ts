import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      'vue/macros': 'vue'
    }
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'VueQrScanner',
      // pastikan nama file match dengan package.json kamu
      fileName: (format) => (format === 'es' ? 'vue-qr-scanner.es.js' : 'vue-qr-scanner.umd.cjs')
    },
    rollupOptions: {
      external: ['vue'],
      output: { globals: { vue: 'Vue' } }
    },
    sourcemap: true
  }
})


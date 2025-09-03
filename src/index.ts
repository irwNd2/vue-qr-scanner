import type { App } from 'vue'
import QrScanner from './QrScanner.vue'
export * from './types'

export { QrScanner }

export default {
  install(app: App) {
    app.component('QrScanner', QrScanner)
  }
}

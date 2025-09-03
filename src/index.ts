import type { App } from 'vue'
import QrScanner from './QrScanner.vue'
export * from './types'
import './styles.css'

export { QrScanner }

export default {
  install(app: App) {
    app.component('QrScanner', QrScanner)
  }
}

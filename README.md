# vue-qr-scanner

**Vue 3 QR/Barcode Scanner** with an overlay bounding-box and smart fallback pipeline:

1. Use native **BarcodeDetector** when available (fast, low CPU)
2. Fallback to **ZXing (WASM)** when not (broad support, multi-format)

## Install

```bash
npm i vue-qr-scanner
# peer: vue@^3
```

> If you use a custom path for the WASM file from `zxing-wasm`, configure it where you create the scanner (see comments in code).


## Usage


### Global plugin
```ts
// main.ts
import { createApp } from 'vue'
import App from './App.vue'
import VueQrScanner from 'vue-qr-scanner'
import 'vue-qr-scanner/style.css'


createApp(App)
.use(VueQrScanner)
.mount('#app')
```


### In a component
```vue
<template>
    <QrScanner :formats="['qr_code']" :frame-interval="2"
    @detect="onDetect" @error="onError">
        <template #controls="{ state, toggleTorch, switchCamera }">
            <div class="controls">
                <button @click="switchCamera">Switch ({{ state.usingBack ? 'Back' : 'Front' }})</button>
                <button @click="toggleTorch" :disabled="!canTorch">Torch: {{ state.torch ? 'On' : 'Off' }}</button>
            </div>
        </template>
    </QrScanner>
</template>


<script setup lang="ts">
import { ref } from 'vue'
import type { DetectedCode } from 'vue-qr-scanner'
const canTorch = ref(true) // set after checking track capabilities if you want

function onDetect(res: DetectedCode[]) {
    // usually you only care the first
    console.log(res[0]?.rawValue, res)
}
function onError(err: Error) {
    console.error('QR error', err)
}
</script>
```

### Props
- `formats: string[]` — forwarded to `BarcodeDetector`; default `['qr_code']`.
- `frameInterval: number` — process every Nth frame (performance); default `1`.
- `mirrorWhenUser: boolean` — mirror overlay when using front camera; default `true`.


### Events
- `@detect` — emits `DetectedCode[]` (each has `rawValue`, optional `format`, `corners`).
- `@error` — camera/decoder errors.

### Notes
- Torch/zoom require device support (`getCapabilities()` / constraints). Not all browsers/devices allow it.
- The overlay canvas auto-scales to the video size and draws boxes when codes are found.

## License
MIT
